---
spec: 029
status: approved
approved: 2026-11-12
---

# Plan: Time tracking — the hours employees spend on company work

> Amended 2026-11-12 after /wellforge:design (ledger D38–D41 and design gaps 2–6): list restore,
> AC-3.3 wording, an export in decimal hours carrying the deal a meeting's hours count for, totals
> semantics with `groupBy=day`, the person filter's source, the activity picker, and three
> `@operai/ui` additions.

Branch `feat/time-tracking`, from `main` (ledger D11). Nothing here depends on PR #9 (specs/026);
the files both touch are listed under Risks (R3). Review decisions of 2026-11-12: ledger D35
(spec amendment AC-4.10), D36 (own service), D37 (own remote); design decisions D38–D41.

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
| `hours-api` (new) | Service skeleton copied from activities-api's shape: `src/index.ts` (CORS with `ALLOWED_ORIGINS`, request logger, 64 KiB body limit, routers, OpenAPI + Scalar, RFC 7807 `onError`/`notFound`), `src/auth/jwt.middleware.ts` (RS256, issuer, `aud=AUTH_AUDIENCE`), `src/lib/{env,db,problem,logger,identities,serviceToken}.ts`, `src/health`. Feature modules: `src/entries/` (CRUD + list), `src/totals/`, `src/lists/` (categories, work types), `src/targets/` (bookability checks), `src/labels/` (fail-soft names and meeting→deal links), `src/oversight/` (read-all, copied from estimai-api `src/estimates/oversight.ts` + `src/lib/authClient.ts`), `src/authz/` (live `time-list:manage`, copied from projects-api `src/auth/authz.middleware.ts` + `src/authz/resolveClient.ts`). Clients: `src/clients/{projects,crm,activities,meetings}.ts` (caller JWT, 2 s, batched; meetings system call with a service JWT). Copied modules registered in `scripts/check-shared-copies.ts` where a group exists (R10). Test harness: `src/test-support/{env,world,hosts}.ts` (activities-api pattern: one scriptable `Bun.serve` playing projects-api, crm-api, activities-api and meetings-api) and `src/matrix.test.ts`. Env (`src/lib/env.ts`): `DATABASE_URL`, `ALLOWED_ORIGINS`, `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_BASE_URL`, `PROJECTS_API_URL`, `CRM_API_URL`, `ACTIVITIES_API_URL`, `MEETINGS_API_URL`, `SERVICE_CLIENT_ID`, `SERVICE_CLIENT_SECRET`, `SERVICE_AUDIENCE` (≠ `AUTH_AUDIENCE`), `PORT=8088`, `NODE_ENV`. Files: `.env.example`, `.envrc`, `Dockerfile`, `bunfig.toml`, `package.json`, `prisma.config.ts`, `railway.json` (`preDeployCommand: bun run db:deploy`), `tsconfig.json`. |
| `activities-api` | `GET /activities` accepts `ids` (≤ 50, comma-separated) as a fifth "exactly one of" filter. Each id's host is resolved **as the caller**, exactly as today; unreadable or missing ids are omitted (identical); an unreachable host is the existing 503. No new table, no catalog. |
| `crm-api` | `src/activity-host/resolve.routes.ts`: `entityType` becomes `"company" \| "deal"`. For `deal` each id is answered with label/href and `involved: [ownerUserId, technicalUserId?]`, the technical contact taken **as the deal view does** (`estimate?.technical` — an override row with `estimateId: ""` is not a technical contact, `deals.routes.ts:244`). Reader = `crm:access`, as for companies. |
| `meetings-api` | (1) `GET /meetings` gains `ids` (≤ 25) — still the caller's own meetings only (creator or Operai participant, `list.routes.ts:57-62`), so one call is both the booking check and the label. (2) First `/system/*` route, `GET /system/meetings/hosts` (service JWT, `aud=SERVICE_AUDIENCE`, scope `meetings.hosts.read`, sub `system:hours-api` only, one identical 401), answering `{id, host}` and nothing else. Copies crm-api's `src/auth/systemAuth.middleware.ts` (verifies against the existing `AUTH_JWKS_URL`). Env: `SERVICE_AUDIENCE`. |
| `auth` | New catalog `auth/src/authz/catalogs/hours.ts`, appId `hours`, **no `access` resource** (the feature is ungated, AC-5.1): `time-entry:read-all` and `time-list:manage`, both `supportedConditions: []`. `seed.ts`: `DECLARED_CATALOGS`, `seedHoursCatalog`, `seedHoursGrants` (admin only, unconditioned); **not** in `ALL_APP_IDS`. `uniqueResourceKeys.test.ts` appId list; `seed.test.ts` block. `system/serviceClients.ts`: `KNOWN_SERVICE_SCOPES += "meetings.hosts.read"`; documented client `hours-api` with that scope. Not added to `DIRECTORY_GATE_PERMISSIONS`: the person filter's options are the `person` groups of `GET /time-entries/totals` (§ Totals), so the user directory's audience is not widened (ADR-0066 untouched). |
| `hours-ui` (new) | Federated remote, dev port **5184** (5182/5183 are the e2e preview defaults of meetings/projects in `shell/playwright.config.ts`), e2e preview 5185. Exposes `./App` (ungated, the whole hours screen) and `./version` (ADR-0030). Screens (`design.md`): My hours (period list grouped by day; **each day's total comes from `GET /time-entries/totals?groupBy=day`** with the list's filters, so a day whose entries straddle two cursor pages shows its full total at once — no client-side sum, no "so far"), the entry dialog (target picker, category / work type, activity, note), the global view for holders of `time-entry:read-all` (person filter, grouped totals, export). **Session imports** declared in `src/federation/remotes.d.ts` and the test stub: `apiFetch`, `usePermissions`, `getHoursApiBaseUrl` (new, below) and the existing `getProjectsApiBaseUrl`, `getCrmApiBaseUrl`, `getMeetingsApiBaseUrl`, `getActivitiesApiBaseUrl` (`shell/src/lib/session.ts:137-176`); those four origins are already trusted by `apiFetch` and already allow the shell origin (`tools/env-doctor/manifest.ts` `CORS_REQUIREMENTS`), so no backend CORS change. **Target pickers** (`SearchPicker`) search what the person can already search, as the caller — projects-api `GET /projects?q=`, crm-api `GET /deals?q=`, meetings-api `GET /meetings?q=` (the caller's own meetings); a 403 maps to the picker's `forbidden` state, a 503 or network failure to `unavailable`; the server decides bookability. **Activity picker**: once a project or deal is picked, the browser calls activities-api as the caller, `GET {getActivitiesApiBaseUrl()}/activities?projectId=<id>&pageSize=100` or `?dealId=<id>&pageSize=100` (`MAX_PAGE_SIZE` 100, activities-api's own order `occurredAt` desc; one page, a "latest N" hint when `total > items.length`; an edited entry's current activity stays an option from its view). A 404 (project or deal not readable through activities-api), 503 `host_unavailable` or a network failure is the picker's error state; the field is optional, so Save stays enabled, and the save is checked by hours-api's own rules (422 `activity_not_allowed`, 503 `host_unavailable`), never by what the picker showed. Rejected: listing activity options through hours-api (a second list contract for a read the person can already make, and hours-api would forward the same JWT anyway). **Person filter** options: the `person` groups of `GET /time-entries/totals?whose=all&groupBy=person` with the view's other filters and **without** `userId` (§ Totals). **Export**: `ExportButton` (`@operai/ui`) + `buildHoursWorkbook(items, copy)` in `src/lib/hoursWorkbook.ts`, `exceljs` lazy-loaded inside `build`, rows from every page of `GET /time-entries` (`limit=500`) with the active filters (inventory-ui `yearWorkbook.ts` pattern); duration as one numeric decimal-hours column and a "Counts for deal" column (§ Export file, D39, D40). `@operai/ui` throughout. |
| `shell` | `getHoursApiBaseUrl()` in `src/lib/session.ts` (`VITE_HOURS_API_URL`, trusted origin, `vite-env.d.ts`, `.env.example`). Ungated splat route `/hours/$` (child of `shellRoute`, no `beforeLoad`, the `/my-meetings` shape); **not** a `TOOLS` entry. UserMenu link "My hours". Runtime remote `hours` (`runtimeRemotes.ts`, `runtime-config.example.json`, `vite.config.ts`, `federation/remotes.d.ts`, stubs), About-modal version, `index.css @source`, Vercel CSP (`script-src`, `connect-src`), strings en/it. |
| `admin-ui` | Page `/time-lists` (`design.md` S5): three cards — categories (name, requires note, status) and the two work-type lists. Row actions: **Rename**; **Retire** on an active row, **Restore** on a retired row (each one `PATCH … { retired }`, AC-3.1 as amended, D38). `src/lib/timeListsApi.ts` via `apiFetch` + `getHoursApiBaseUrl` (added to `federation/remotes.d.ts` and the stub). Nav entry shown only with `time-list:manage` (`SectionNav.tsx`, the `rate:read` pattern); a 403 renders `PermissionDenied`. admin-ui is the gated Admin tool (`shell/src/lib/tools.ts` entry `admin`), so reaching the page needs Admin access **and** `time-list:manage`, while hours-api's gate is `time-list:manage` alone: a role given the permission without Admin access can call the API but cannot reach the screen (AC-3.3 as amended, D41; the mileage-rate pattern, ADR-0023). |
| `@operai/ui` | Four additions, each with a story and a test, exported from `src/index.ts` with their prop types; changeset `@operai/ui` minor. (1) `formatDuration` gains `style: 'short'` → "2 h 30" / "2 h" / "30 min" (AC-4.9; the `DurationStyle` union in `src/lib/format.ts`; story in `src/foundations/Formatting.stories.tsx`, test in `src/lib/i18n-format.test.tsx`). (2) `formatMonth` (same files) for the by-month totals, whose keys are `YYYY-MM`: "November 2026" / "novembre 2026". (3) **`SearchPicker`** (`src/components/SearchPicker.{tsx,stories.tsx,test.tsx}`): a `Field`-wrapped `Combobox` for a **server-side** search — debounce, abort and discard of stale answers, picked never typed (typing after a pick clears it), `emptyState` for searching / no match / forbidden / unavailable, the result count announced. hours-ui is its third consumer after `crm-ui/src/components/CompanyPicker.tsx` and `projects-ui/src/components/CompanyPicker.tsx`, which migrate later (not in this spec). (4) **`ExportButton`** (`src/components/ExportButton.{tsx,stories.tsx,test.tsx}`): the download button of `inventory-ui/src/components/ExportYearButton.tsx` — `aria-busy` not `disabled`, a second click ignored, polite "preparing / ready" status, a failure alert, the object URL revoked — with hours-ui as the second consumer (AGENTS.md: a pattern a second app needs goes into the library); inventory-ui migrates later. Contract sketches in § API contracts. `docs/design-system.md` (§ Suggestions while typing) and `docs/decisions.md` (next free D-numbers) record the two components. Rejected: a local `ExportEntriesButton` in hours-ui (`design.md`'s fallback — a second copy of an app pattern, which AGENTS.md forbids); `PersonPicker` for the target pickers (it filters an already loaded list client-side). |
| Infra / release | `infra/provision-tool.sh hours` (the standard api + ui pair: Railway service `hours-api`, database `hours`, Vercel project `hours-ui`, DNS), `infra/check.sh` (health + 401 probes), `infra/README.md` section; `compose.yaml` service; `mise.toml` (`dev`, `dev:web`, `dev:preview`, `db:migrate`); `tools/env-doctor/manifest.ts` (`SERVICES`, `ORIGINS`, `resourceServers`, `AUTH_*` links, `CORS_REQUIREMENTS` hours-api `mustAllow: ["shell", "admin-ui"]`, `REQUIRED_KEYS`, `INTERNAL_URL_VARS` for the four internal URLs, `SERVICE_CLIENT_LINKS` hours-api `["meetings.hosts.read"]`, meetings-api `SERVICE_AUDIENCE`) + `templates/production/hours-api.env` + its tests; `lerna.json` (`hours-api`, `hours-ui`); changesets (auth, hours-api, hours-ui, activities-api, crm-api, meetings-api, shell, admin-ui, operai-ui — the last one minor, for the four additions above); `AGENTS.md`, `README.md`. |

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

**Change an entry** (`PATCH`): the steps above run only when `on` moves the entry to a different target
(D46, AC-2.12). A change that keeps the target re-validates the local rules (step 2: duration, day, note,
category / work type against the stored target type) and, for a new `activityId`, step 5 alone; it calls
no owner otherwise. *Rejected:* re-checking bookability on every change (the plan's first reading of A3) —
an author who left a team could then only delete an entry to correct it, losing the hours, while delete
already needs no check.

**List / totals** (`GET /time-entries`, `GET /time-entries/totals`):
1. `whose=mine` (default): JWT only, scoped to `sub`. `whose=all`: oversight (below).
2. A `dealId` filter first asks `GET /system/meetings/hosts?dealId=` for the meetings currently
   linked to that deal, so their entries match too (AC-2.6). When that route does not answer, the
   whole read is refused with 503 `host_unavailable` and nothing partial is returned (AC-4.11,
   D45; § Totals, "When the meeting → deal link is unavailable").
3. Query entries (SQL; indexes `userId, day`, `projectId, day`, `dealId, day`, `meetingId`).
4. In parallel, fail soft, each source named in `unavailable[]` when it does not answer:
   identities (`identities`; `auth POST /authz/users/identities`, ≤ 100), project labels
   (`projects`; projects resolve, 25), deal labels (`crm`; crm resolve `deal`, 25 — the deals of the
   page's deal entries **and** the deals its meetings are linked to), pointed activities
   (`activities`; activities-api `GET /activities?ids=`, 50), meeting titles (`meetings`;
   `GET /meetings?ids=`, 25 — only meetings the **viewer** took part in), meeting → deal links
   (`meeting-deals`; `GET /system/meetings/hosts?ids=`, 100). Labels follow the **viewer's** access
   (AC-4.10): an entity the viewer cannot read is `visibility: "hidden"`, label `null`, and the
   activity subject is `null`. Totals ask only the sources their grouping needs (§ Totals).
5. Grouping by deal places a meeting's entries under its current deal (AC-2.6); a meeting whose
   link could not be read goes to the `deal-unknown` group.

**A pointed activity that was deleted** (AC-2.9) is derived on read, not swept (ADR-0013): when
the viewer can read the entry's project or deal and activities-api no longer returns the pointed
id, the view shows `activity: null`; when the project or deal itself is hidden from the viewer the
activity is shown as hidden too (AC-4.10). The stored id is **never cleared** — not on read, not on a
later write (D47): activities-api omits an id the caller cannot read exactly like a deleted one, so
clearing it on a write would drop a live pointer for an author who merely lost read access, and a
`PATCH` that keeps the target makes no owner call at all (AC-2.12). A changed `activityId` is validated
as in step 5. *Rejected:* reconcile on write (loses live pointers, needs an owner call on every keep-
target `PATCH`); clearing only after the host confirms the author still reads the target (an extra call
for a cosmetic cleanup). A dangling id costs one text column.

**Oversight** (`whose=all`, a `userId` filter, any write on someone else's entry): hours-api asks
`auth GET /authz/resolve` with the caller's JWT for `time-entry:read-all`. A refusal is cached by
`(sub, perm_epoch)` for 30 s, a grant never (ADR-0075). `auth` unreachable → 503
`authz_unavailable` on reads; on a write to someone else's entry the check only decides 403
`owner_only` vs 404, and a failed check answers 404.

**Admin lists**: `time-list:manage` resolved live on every list write — create, rename, retire and
restore alike (projects-api `authzMiddleware` shape: cache `(sub, perm_epoch)` 30 s, 503 when
`auth` is down, 403 without it). Reading the lists needs only a JWT.

### Decisions this plan makes (ADR candidates — see the end)

- Own service `hours-api` (ADR-0088; the user's choice, D36).
- Bookability asked as the caller of each owner, plus the meeting→deal link read live (ADR-0089).
- hours-ui as its own ungated remote (ADR-0090; D37).
- **No `If-Match` on time entries.** ADR-0038 protects records several people write; an entry has
  one writer, its person. Two tabs of the same person: last write wins. Recorded in ADR-0088.
- Retiring a category or work type is reversible: `PATCH … { retired: false }` restores it (AC-3.1
  as amended, D38); only deleting is forbidden (AC-3.2).
- Category and work-type names are unique per list, case-insensitive, retired included (409).
- **Every figure the screens show is computed by `GET /time-entries/totals`**, day totals included
  (`groupBy=day`); the client never sums a page (design gap 5, § Totals).
- **What the viewer cannot name is merged**, in totals and in the export, into one group per reason
  (`hidden`, `unavailable`, `deal-unknown`); the deal a meeting is linked to is returned with its id
  only to a viewer who can read that deal (design gap 3, D40, § Views and § Totals).

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
  retiredAt    DateTime?                     // null = active; set by retire, cleared by restore (D38)
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
  retiredAt DateTime?                        // as TimeCategory.retiredAt
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
Restore (D38) needs no schema change: it clears `retiredAt`.

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
        deal: MeetingDeal }
    | { type: "none"; category: { id: string; name: string; retired: boolean } }
  workType: { id: string; name: string; retired: boolean } | null
  activity: { id: string; subject: string | null; visibility: Visibility } | null // null: none, or deleted
  createdAt: string
  updatedAt: string
}

// The deal a meeting entry's hours count for (AC-2.6, AC-4.5), carried so the export can sum by
// deal (AC-4.6, D40). Read live on every request; never stored on the entry.
type MeetingDeal =
  | { state: "linked"; visibility: "visible"; id: string; label: string; href: string }
  | { state: "linked"; visibility: "hidden" | "unavailable" }  // no id, no name (below)
  | { state: "none" }       // meetings-api answered: linked to no deal, or the meeting no longer exists
  | { state: "unknown" }    // the system route did not answer: "meeting-deals" is in `unavailable`

type Unavailable =
  ("projects" | "crm" | "activities" | "meetings" | "meeting-deals" | "identities")[]
  // meetings: meeting titles, read as the viewer (GET /meetings?ids=)
  // meeting-deals: a meeting's current deal, read with hours-api's own credential
  //                (GET /system/meetings/hosts) — it fails independently (scope, deploy order R7)
```

`href` values are suite paths only: `/projects/<id>`, `/crm/deals/<id>`, `/my-meetings/m/<id>`.

**How `on.deal` is filled.** hours-api reuses the call totals already make: the page's meeting ids
go to `GET /system/meetings/hosts?ids=` (≤ 100 per call); each `host` with
`{app:"crm", entityType:"deal"}` gives the deal id, which joins the page's deal ids in the **same**
crm-api resolve `deal` batch, sent with the **viewer's** JWT. The deal's visibility is the viewer's
access to the **deal** (AC-4.10), independent of their access to the meeting: `reader:false` or
`missing` → `hidden`; crm-api not answering → `unavailable` (source `crm`). The id is returned only
with `visibility: "visible"`: the link was read with hours-api's own credential, and a viewer who
cannot read the deal must not learn which deal a meeting is linked to (ADR-0058, ADR-0089). The
system route not answering → `{ state: "unknown" }` and `meeting-deals` in `unavailable`; the entry is
still listed and counted (AC-4.7). *Rejected:* a flat `meetingDeal` member on every view (null on
three targets of four) and the earlier `deal: {…} | null` (cannot tell "no deal" from "could not
ask", which the export and the by-deal totals must keep apart).

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
  200 TimeEntryView                    // bookability (AC-2.2/2.3/2.5) is checked only when `on` is sent and
                                       // differs from the stored target; a PATCH that keeps the target
                                       // (day, minutes, note, workTypeId) makes no owner call at all, so it
                                       // succeeds on a project/deal the author left or cannot read (AC-2.12,
                                       // D46). A new `activityId` is still checked (AC-2.7: 422
                                       // `activity_not_allowed`, 503 when activities-api does not answer);
                                       // `activityId: null` is never checked. `on` equal to the stored
                                       // target counts as unchanged.

DELETE /time-entries/{id}              // owner only; no bookability check
  204

GET /time-entries?whose=mine|all&from&to&userId&target&projectId&dealId&meetingId&categoryId
                 &workTypeId&cursor&limit
  // from/to required, span ≤ 366 days; limit 1..500 (default 100); order day desc, createdAt desc
  // userId only with whose=all; dealId includes entries on meetings linked to that deal
  200 { items: TimeEntryView[]; nextCursor: string | null; unavailable: Unavailable }
```

### Totals

```
GET /time-entries/totals?groupBy=person|project|deal|category|month|day&<the list's filters>
  // same whose, filter and span rules as the list; no cursor or limit: the answer is never paged
  200 { totalMinutes: number; groups: TotalsGroup[]; unavailable: Unavailable }
```

```ts
type TotalsGroup =
  | { kind: "keyed"; key: string; label: string | null; minutes: number;
      status?: Person["status"]      // groupBy=person only
      retired?: boolean }            // groupBy=category only
  | { kind: "none"; minutes: number }          // entries outside the grouping (table)
  | { kind: "hidden"; minutes: number }        // project | deal: all the viewer may not read, merged (AC-4.10)
  | { kind: "unavailable"; minutes: number }   // project | deal: the owner did not answer, merged (AC-4.7)
  | { kind: "deal-unknown"; minutes: number }  // deal: meeting entries whose current deal could not be read
```

- **Complete.** Every entry that matches the filters is counted in exactly one group;
  `Σ groups[].minutes === totalMinutes`; `groups` is never paged or truncated. No zero-minute group
  (a month without entries is absent, not padded). Size is bounded by the span (≤ 366 days, ≤ 13
  months), the list sizes, and the people / projects / deals with entries in it.
- **Sources asked.** `unavailable` names only the sources this grouping and these filters needed:
  `day`, `month` and `category` read no other service (a `dealId` filter adds `meeting-deals`);
  `person` reads `identities`; `project` reads `projects`; `deal` reads `meeting-deals` and `crm`.

| `groupBy` | `keyed` groups | `key` | `label` | other kinds | order of `groups` |
|---|---|---|---|---|---|
| `person` | one per person with matching entries | user id (usable as `userId`) | live name from `auth POST /authz/users/identities` (ADR-0039, AC-4.8), `status` likewise; `null` + `status: "unknown"` when not resolved (source `identities`) | — | `label` by `Intl.Collator("en", { sensitivity: "base" })`, `null` labels last, then `key` |
| `project` | one per project the viewer can read | project id | the project's label as the viewer reads it | `hidden`, `unavailable`, `none` (deal, meeting and no-entity entries) | `minutes` desc, then `label`, then `key`; then `hidden`, `unavailable`, `none` |
| `deal` | one per deal the viewer can read: entries on the deal **plus** entries on meetings currently linked to it (AC-2.6) | deal id | the deal's label as the viewer reads it | `hidden`, `unavailable` (crm did not answer), `deal-unknown` (meeting entries; `meeting-deals` did not answer), `none` (project and no-entity entries; meetings linked to no deal or no longer existing) | as `project`; then `hidden`, `unavailable`, `deal-unknown`, `none` |
| `category` | one per category used | category id | the name as typed (AC-3.8), `retired` | `none` (project, deal and meeting entries) | `minutes` desc, then `label`; then `none` |
| `month` | one per calendar month with entries | `YYYY-MM` of `day` | `null` — the UI formats the key with `formatMonth` | — | `key` desc (newest first, the list's order) |
| `day` | one per day with entries | `YYYY-MM-DD` | `null` — the UI uses `formatDateLong` | — | `key` desc |

**Day totals (design gap 5).** *Chosen:* `groupBy=day`. My hours asks it with the list's filters and
shows the server's figure next to each day heading, whichever page the day's entries arrive on.
*Rejected:* day-aligned pages (a page's size would no longer be bounded by `limit`, and paging would
follow a display grouping the Everyone's table does not use); a `dayTotals` member on each list page
(a second aggregation shape on the list contract, when the totals route already owns aggregation and
its invariant); a client sum marked "so far" (wrong until the last page).

**Person filter (design gap 2).** *Chosen:* the filter's options are the `person` groups of
`GET /time-entries/totals?whose=all&groupBy=person&from&to&<the other filters>` **without**
`userId` — complete (never paged, so it lists people beyond the first list page), `key` = user id,
`label` = live name, failing soft (`null`, `status: "unknown"`, `identities` named). It lists exactly
the people with hours in the period. *Rejected:* adding `time-entry:read-all` to
`DIRECTORY_GATE_PERMISSIONS` (a new audience for the user directory, the widening ADR-0066 warns of,
and it would list people who recorded nothing); a dedicated `GET /time-entries/people` (the same
distinct-user query behind a second route).

**What the viewer cannot name (design gap 3).** *Chosen:* for `project` and `deal`, every entity the
viewer may not read is one `hidden` group and every entity whose owner did not answer is one
`unavailable` group, and the export writes the same placeholder for each (§ Export file), so the file
summed by deal equals these groups (D40). *Rejected:* one group per unreadable or unanswered id — a
column of identical "not visible to you" rows nobody can tell apart, which an export without ids
(AC-4.10) cannot reproduce, and which for meeting-linked deals would need the id hours-api read with
its own credential (withheld, § Views).

**When the meeting → deal link is unavailable** (the system route does not answer):
- `groupBy=deal`: meeting entries are counted in `deal-unknown`; `totalMinutes` is unchanged.
- A `dealId` filter (list, totals, and therefore the export that walks the list): the whole read is
  refused with 503 `host_unavailable`; nothing partial is returned (AC-4.11). The owner chose this
  (D45) over the architect's recommendation of answering with the deal's own entries and
  `meeting-deals` in `unavailable`: a deal's figures are never shown low, at the cost of the deal
  filter not working while meetings-api is unreachable (a redeploy of its single replica, a crash or
  a network error — seconds to minutes; the next read after it answers is complete, nothing is
  stored). This departs on purpose from ADR-0080's "a read degrades" for this one filter.
  *Rejected:* the partial answer above; counting every meeting entry of the period as a possible
  match (wrong totals). `groupBy=deal` without a `dealId` filter still degrades (bullet above): its
  `totalMinutes` stays right and the `deal-unknown` group says where the gap is.
- A list item on a meeting: `on.deal = { state: "unknown" }`.

### Errors (entries and totals)

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_request` | schema violation, unknown key, bad query (span, `userId` without `whose=all`, unknown `groupBy`) |
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
| 503 | `host_unavailable` | projects-api, crm-api, activities-api or meetings-api did not answer a write's check; or, on a read with a `dealId` filter (list, totals), meetings-api's `GET /system/meetings/hosts?dealId=` did not answer (AC-4.11, D45) |
| 503 | `authz_unavailable` | `auth` did not answer an oversight read or a list write |

### Lists

```
GET /time-lists?includeRetired=true|false          // any JWT
  200 { categories: CategoryView[]; workTypes: { project: WorkTypeView[]; deal: WorkTypeView[] } }

type CategoryView = { id: string; name: string; requiresNote: boolean; retired: boolean }
type WorkTypeView = { id: string; list: "project" | "deal"; name: string; retired: boolean }

POST  /time-categories       { name: string (1..80, trimmed), requiresNote?: boolean }        → 201 CategoryView
PATCH /time-categories/{id}  { name?: string; requiresNote?: boolean; retired?: boolean }   → 200 CategoryView
POST  /work-types            { list: "project" | "deal", name: string (1..80, trimmed) }      → 201 WorkTypeView
PATCH /work-types/{id}       { name?: string; retired?: boolean }                            → 200 WorkTypeView
  // PATCH: at least one member; strict (any other key, `list` included → 400 invalid_request)
  // time-list:manage, live: 403 time_list_manage_required, 503 authz_unavailable,
  // 409 name_taken, 404 not_found; no DELETE route is mounted (AC-3.2)
```

Retire and restore — the same `PATCH` on both routes:
- `retired: true` sets `retiredAt = now()` (kept when already set): the item leaves
  `GET /time-lists` without `includeRetired`, is refused on new and changed entries (`*_retired`), and
  stays on — and is shown by — the entries that have it (AC-3.4).
- `retired: false` **restores** it (AC-3.1 as amended, D38): `retiredAt = null`, offered again in
  `GET /time-lists` and accepted on new and changed entries.
- Both are idempotent (200, row unchanged) and neither touches an entry.
- Names stay unique: uniqueness (`lower(name)`, per list for work types) already spans retired rows,
  so a restore alone can never collide; a rename in the same `PATCH` is checked like any rename
  (409 `name_taken`, nothing changes — one transaction).

### Export file (hours-ui, built in the browser — AC-4.6, AC-4.10, D39, D40)

`buildHoursWorkbook(items: TimeEntryView[], copy): Workbook` in `hours-ui/src/lib/hoursWorkbook.ts`:
one sheet, one row per item in the list's order, from every page of `GET /time-entries` with the
active filters (`limit=500` until `nextCursor` is `null`). Headers and placeholder words come from the
strings catalog in the viewer's language. The file carries no ids.

| # | Column | Cell |
|---|---|---|
| 1 | Day | a date cell from `day` (`dd.mm.yyyy`) |
| 2 | Person | `person.name`; `null` → the "Unknown user" word |
| 3 | Hours | a **number**, `minutes / 60` (150 → 2.5; always a multiple of 0.5, exact), number format `0.0` — never a "2 h 30" string (D39; AC-4.9 is the screen) |
| 4 | On | the type word: Project / Deal / Meeting / Other work |
| 5 | Name | the project, deal or meeting `label`; `hidden` → "Not visible to you"; `unavailable` → "Name unavailable"; empty for other work |
| 6 | Counts for deal | the deal the hours count for (D40): an entry on a deal → that deal; on a meeting → `on.deal` (`linked` + `visible` → its label, `hidden` → "Not visible to you", `unavailable` → "Name unavailable", `unknown` → "Unknown", `none` → empty); project and other work → empty |
| 7 | Category or work type | the name as typed (AC-3.8) |
| 8 | Activity | `activity.subject`; `hidden` → "Not visible to you"; none or deleted → empty |
| 9 | Note | the full note |

Column 3 summed by column 6 equals the `groupBy=deal` groups for the same filters: a deal's label ↔
its `keyed` group, the three placeholders ↔ `hidden`, `unavailable`, `deal-unknown`, the empty cell ↔
`none`. *Chosen:* one "Counts for deal" column, filled for deal entries too. *Rejected:* a "Deal (via
meeting)" column filled only for meeting entries (`design.md` gap 7's wording) — summing by deal would
then need two columns combined; two duration columns (text + decimal), the owner's call in D39.

### `@operai/ui` additions (sketches)

```ts
// src/lib/format.ts
type DurationStyle = 'clock' | 'spoken' | 'short'            // short: "2 h 30", "2 h", "30 min"
function formatMonth(month: string /* YYYY-MM */ | Date, locale?: Locale): string
                                                             // "November 2026" / "novembre 2026"; a malformed key throws

// src/components/SearchPicker.tsx
type SearchResult<T> = { ok: true; items: T[] } | { ok: false; reason: 'forbidden' | 'unavailable' }
type SearchPickerProps<T> = {
  label: string; hint?: string; required?: boolean; error?: string | null
  value: T | null
  onChange: (value: T | null) => void
  search: (q: string, signal: AbortSignal) => Promise<SearchResult<T>>  // the app maps 403 / 503 / network
  toOption: (item: T) => ComboboxOption
  messages: { searching: string; noMatch: string; forbidden: string; unavailable: string;
              count: (n: number) => string }
  delayMs?: number                                                     // default 250 (CompanyPicker's)
  testId: string
}

// src/components/ExportButton.tsx
type ExportButtonProps = {
  label: string
  build: () => Promise<{ data: BlobPart; fileName: string; readyMessage?: string }>
                                     // the app lazy-imports exceljs here; readyMessage e.g. "names missing"
  messages: { busy: string; ready: string; failed: string }
  mimeType?: string                  // default the XLSX type
  resetKey?: string                  // a change clears the status line (the filters changed)
  variant?: 'secondary' | 'ghost'
  testId: string
}
```

### activities-api (changed)

```
GET /activities?ids=a,b,c          // ≤ 50; exactly-one-filter rule unchanged (ids is the fifth)
  200 { items: Activity[]; total; page; pageSize }   // existing Activity view; unreadable/missing ids omitted
  503 host_unavailable                               // as today
```

hours-ui also reads the existing `GET /activities?projectId=` / `?dealId=` from the browser for the
activity picker (unchanged route, § Components `hours-ui`).

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
component tests. E2E: `shell/e2e/hours.spec.ts` through the host. The `@operai/ui` additions carry
their own story and test (`formatMonth` and `short` in `src/lib/i18n-format.test.tsx`, `SearchPicker`
and `ExportButton` in their `*.test.tsx`), referenced by the rows below where an AC rests on them.

| AC | Level | Test |
|---|---|---|
| AC-1.1 | integration + e2e | employee with no tool grant `POST` a `none` entry → 201, listed by `GET whose=mine`; e2e records one from `/hours` |
| AC-1.2 | unit + integration + DB | 0, 15, 45, 1470 → 422 `invalid_minutes`; 30 and 1440 → 201; raw insert breaks `time_entry_minutes` |
| AC-1.3 | unit + integration | `todayIn("Europe/Zurich")` across the UTC midnight boundary; tomorrow → 422 `future_day` |
| AC-1.4 | integration | 6 h on an internal project + 6 h on a client project the same day → both 201; `groupBy=project` gives 6 h each, `groupBy=day` gives that day 12 h |
| AC-1.5 | integration | owner `PATCH`es and `DELETE`s an entry dated 400 days ago → 200 / 204 |
| AC-1.6 | integration | another user (admin included) `PATCH`/`DELETE` → 404; read-all holder → 403 `owner_only`; `POST` with `userId` → 400; row unchanged |
| AC-1.7 | integration + DB | 1001 characters → 422 `note_too_long`; 1000 → 201; CHECK holds |
| AC-1.8 | contract | strict schema: `start`/`end` keys → 400; OpenAPI view has no time-of-day member |
| AC-2.1 | unit + DB | every target / category / work-type combination: allowed → 201, others → 400/422; CHECK rejects raw rows |
| AC-2.2 | integration (fake projects) | caller in `assignees` → 201 in every state, `writable:false` ignored; readable but not in `assignees` → 403 `not_on_project`; `reader:false` → 404 |
| AC-2.3 | integration (fake crm + activities) + crm-api integration | involved as owner, technical contact, task assignee, participant → 201; other CRM reader → 403 `not_involved_in_deal`; won and lost deals accepted. crm-api: resolve `deal` returns owner + technical, leaves out an override row's admin, `reader:false` without `crm:access` |
| AC-2.4 | integration | entry created, caller then removed from `assignees`: still listed and counted under the project; `DELETE` → 204 |
| AC-2.5 | integration (fake meetings) + meetings-api integration | creator or participant → 201; host-only reader (absent from `GET /meetings?ids=`) → 404. meetings-api: the `ids` filter returns only the caller's meetings |
| AC-2.6 | integration + meetings-api integration | meeting entries grouped under deal A and listed with `on.deal = { state: "linked", id: A }`; fake system route relinks to B → totals and the item move to B. meetings-api: the system route answers `{id, host}` only; a user JWT, a wrong scope or a wrong sub → identical 401 |
| AC-2.7 | integration + activities-api integration + component | activity of another project/deal → 422 `activity_not_allowed`; on `meeting`/`none` → 422; a task of the same project → 201. activities-api: `ids` filter returns readable activities only, omits missing and unreadable alike. hours-ui: the activity picker loads `GET /activities?projectId=` / `?dealId=` for the picked entity; a 404 or 503 shows its error state and Save stays enabled |
| AC-2.8 | integration | two people, three days, one task → all 201, same `activity.id` in the list |
| AC-2.9 | integration | fake activities-api stops returning the pointed id → entry still listed and counted, `activity: null`, export activity cell empty; owner then changes the note → 200 and the stored `activityId` is unchanged (D47); project hidden from the viewer → activity rendered hidden, not `null` |
| AC-2.12 | integration (fake projects + crm + activities + meetings) | entry on a project, caller then removed from `assignees`: `PATCH {minutes, note, workTypeId, day}` → 200 and the fake host records **no** resolve call; same with the project now `reader:false` → 200; `PATCH {on: <same project>}` → 200, no call; `PATCH {on: <another project the caller is not on>}` → 403 `not_on_project`, row unchanged; `PATCH {activityId: <task of that project>}` with activities-api down → 503; deal (involvement lost) and meeting (no longer a participant) variants alike |
| AC-2.10 | integration | missing vs unreadable project, deal, meeting → byte-identical 404 bodies |
| AC-2.11 | integration | each source down / timeout / 500 during a write → 503 `host_unavailable`, no row written |
| AC-3.1 | integration + component (admin-ui) | holder creates, renames, retires and **restores** a category and a work type in each list; after `PATCH { retired: false }` the item is back in `GET /time-lists` and a new entry with it → 201; retire and restore are idempotent (200, row unchanged); rename-and-restore to a taken name → 409 `name_taken`, row unchanged. admin-ui: an active row offers Rename + Retire, a retired row Rename + Restore, each sending one `PATCH` |
| AC-3.2 | integration + DB | `DELETE /time-categories/{id}` and `/work-types/{id}` → 404, row present; raw delete of a used row blocked by `Restrict` |
| AC-3.3 | integration + component (admin-ui) | a caller without `time-list:manage` — including one whose role has Admin access but not the permission — → 403 `time_list_manage_required` on create, rename, retire and restore, row unchanged; `auth` down → 503 `authz_unavailable`; a role holding `time-list:manage` without Admin access → the API accepts (hours-api's gate is the permission alone). admin-ui: no Time lists link and `PermissionDenied` on `/time-lists` without `time-list:manage` |
| AC-3.4 | integration | retired item absent from `GET /time-lists`, present with `includeRetired`; new entry with it → 422 `*_retired`; old entry still shows it, `retired: true` |
| AC-3.5 | integration | project entry with a deal work type → 422; meeting / none with a work type → 422; none without → 201 |
| AC-3.6 | integration | `tc-other` without note → 422 `note_required`; with a note → 201 |
| AC-3.7 | migration | a fresh test database holds exactly the A15 rows |
| AC-3.8 | component (hours-ui, admin-ui) | a name typed "Formazione" renders verbatim with `lang=en` and `lang=it` |
| AC-4.1 | integration + component + e2e | integration: `groupBy=day` keys `YYYY-MM-DD`, newest first, each the sum of that day's matching entries. component: My hours shows each day's total from `groupBy=day` — a day whose entries straddle two list pages shows its full total before Load more; no "incomplete" marker in the DOM; no notification call. e2e: two entries on one day → that day's total on `/hours` |
| AC-4.2 | integration | `whose=all` or `userId` without the permission → 403 `read_all_required` (list and totals); `whose=mine` never returns another person's row |
| AC-4.3 | integration | holder sees entries of `welld_ch` and `welld_it` users |
| AC-4.4 | integration + component | each filter narrows items and totals alike; the person filter's options are the `groupBy=person` groups without `userId`: complete with more people than one list page holds, `key` = user id, `label` = live name, `null` + `identities` in `unavailable` when identities fail |
| AC-4.11 | integration + component | `dealId` filter with `GET /system/meetings/hosts?dealId=` down / timeout / 500 → list and totals both 503 `host_unavailable`, no `items`/`groups` body; same filter with the route up → 200 including the meeting entries; no `dealId` filter with the route down → 200 (degrades as AC-4.5/4.7). component: the filtered view shows its "try again" error state, not an empty or partial list; export with the deal filter fails with the same error |
| AC-4.5 | integration + component | each `groupBy`: `key`, `label` and order as in § Totals; `Σ groups.minutes = totalMinutes` for every `groupBy` over one fixture; meeting entries under their current deal; one `none` group; two deals the viewer cannot read → one `hidden` group; system route down → meeting entries in `deal-unknown`, `meeting-deals` in `unavailable`, `totalMinutes` unchanged (no `dealId` filter). component: month groups labelled through `formatMonth` |
| AC-4.6 | unit + component | `buildHoursWorkbook(items)`: rows = items in order; the nine columns of § Export file in order; Hours is a numeric cell `minutes / 60` (30 → 0.5, 150 → 2.5, 1440 → 24) with format `0.0`; Counts for deal holds the deal for a deal entry and for a meeting linked to one; over one fixture, Hours summed by Counts for deal = that fixture's `groupBy=deal` groups (placeholders ↔ `hidden` / `unavailable` / `deal-unknown`, empty ↔ `none`). component: export walks every page with the active filters; a page with `unavailable` → the ready status says names are missing |
| AC-4.7 | integration | each source down → entries still listed and counted, `visibility: "unavailable"`, source in `unavailable`; system route down → meeting entries listed with `on.deal = { state: "unknown" }`, `meeting-deals` named |
| AC-4.8 | integration | the identities stub renames a person between two calls → the second list and the `person` groups show the new name |
| AC-4.9 | unit (operai-ui) + unit + component | `formatDuration` `short`: 150 min → "2 h 30", 120 → "2 h", 30 → "30 min", both locales; hours-ui rows, day totals and totals render through it; the workbook's Hours cell is a number, never the short string (D39) |
| AC-4.10 | integration + unit | holder without `crm:access` lists a deal entry → `visibility: "hidden"`, `label: null`, `activity.subject: null`, minutes counted; a meeting entry linked to a deal the holder cannot read → `on.deal = { state: "linked", visibility: "hidden" }` with no `id`; `groupBy=deal` counts both in the one `hidden` group; the workbook writes the type and "Not visible to you" in Name, Counts for deal and Activity, never a name or an id |
| AC-5.1 | e2e + shell unit | a user with only `employee` opens `/hours` (no access redirect) and records a `none` entry; `tools.test` asserts `/hours` is not a tool |
| AC-5.2 | auth seed contract | catalog `hours` has exactly the two actions with `[]` conditions; admin is the only holder, unconditioned; a role rule `time-entry:read-all` is accepted by `roles.routes` |
| AC-5.3 | matrix | every hours-api route is classified and answers 401 without a credential |
| AC-5.4 | integration | `auth` down: `whose=all` → 503 `authz_unavailable`; `whose=mine` → 200 |
| AC-5.5 | component | `catalogGaps` parity and `noHardcodedStrings` in hours-ui, admin-ui, shell; the workbook's headers and placeholders come from the catalog |

All 44 ACs of the spec (41 + AC-4.10 + AC-4.11 + AC-2.12) have a row. Re-checked after the 2026-11-12 amendment: the
rows for AC-3.1, 3.3, 4.1, 4.4, 4.5, 4.6, 4.7, 4.9 and 4.10 were rewritten so each fails when the
amended AC is violated (no restore; restore allowed without the permission; a day total from one page;
an incomplete person list; groups that do not sum; a text duration or a missing deal in the file; a
name or an id that leaks).

## Risks

- **R1 A new service to run.** Database, Railway service, env contract, deploy order, on-call.
  *Mitigation:* `provision-tool.sh hours` creates the standard pair; env-doctor carries the
  contract. *Early check:* `provision-tool.sh hours` without `--apply` and `mise run env:doctor`
  green before the first deploy.
- **R2 Write, list, totals and export latency.** A deal booking may ask crm-api and up to 10 pages
  of activities-api; a list page asks up to six sources; My hours now makes three calls per filter
  change (list, chosen totals, `groupBy=day`). `groupBy=deal` asks the system route for every distinct
  meeting with entries in the span (100 per call), and an export walks every page of the span.
  *Mitigation:* the owner/technical answer short-circuits the activities scan; per-source batching in
  parallel, 2 s each, fail soft on reads; pages ≤ 500; `day`, `month` and `category` totals are SQL
  only. *Early check:* p95 of `POST` on a deal, of a month's `GET whose=all`, of a year's
  `groupBy=deal whose=all`, and the time of a quarter's export for everyone, in the e2e stack; revisit
  above 800 ms (an activities-api `involvedIn=me` filter, a `POST /system/meetings/hosts` taking ≤ 1000
  ids, or a server-built export, in that order).
- **R3 PR #9 overlap.** Additive edits in files PR #9 also changes: `auth/src/authz/seed.ts`,
  `auth/src/authz/seed.test.ts`, `auth/src/system/serviceClients.ts`,
  `auth/src/system/serviceClients.test.ts`, `auth/.env.example`, `compose.yaml`,
  `scripts/check-shared-copies.ts`, `tools/env-doctor/manifest.ts`, env-doctor `check.test.ts` /
  `resolve.test.ts` and its `auth.env` / `crm-api.env` production templates, `AGENTS.md` (the admin-ui
  route goes in `admin-ui/src/router.tsx`, which PR #9 does not touch; list corrected 2026-11-13 while
  deriving tasks). *Mitigation:* edits in new blocks. *Early check:* `git merge-tree` against
  `fork/feat/projects-handoff` (or `main` once PR #9 merges) before each of those tasks merges.
- **R4 Managers see less than they expect** (AC-4.10). A holder without CRM or Projects access sees
  hours on deals/projects without names, and their by-project or by-deal totals show one merged
  "not visible to you" group. *Mitigation:* the UI says "not visible to you" with the type.
- **R5 Picker offers projects/deals the person may not book on.** Search uses existing list
  endpoints; the server refuses with a clear 403. *Mitigation:* copy names the reason; a member-only
  project filter can follow PR #9 (projects-api is not touched here).
- **R6 Deleted activity vs unreachable or unreadable.** Nothing clears a pointer (D47): an omitted id
  shows `activity: null` while the project/deal is readable, a 503 names `activities` in `unavailable`.
  *Early check:* AC-2.9 test plus a 503 variant and a lost-access variant (id kept).
- **R7 Deploy order.** auth (catalog, scope) → activities-api, crm-api, meetings-api → hours-api →
  admin-ui, hours-ui, shell. A not-yet-updated owner does not answer 404: an old crm-api answers 422 to
  `entityType:"deal"`, an old activities-api 422 to `ids` alone, and an old meetings-api ignores `ids`
  and returns the caller's latest page. hours-api's clients therefore treat **any unexpected 4xx** as
  `unavailable` (503 `host_unavailable` on a write) and **drop ids they did not ask for** (corrected
  2026-11-13), so a wrong order degrades, never breaks.
- **R9 Deal involvement beyond the scan bound.** The activities scan reads at most 10 pages (1000
  activities) of a deal; a person involved only through an activity past that bound is refused
  `not_involved_in_deal` (accepted 2026-11-13). *Early check:* none needed below 1000 activities per
  deal; revisit with R2's `involvedIn=me` filter.
- **R10 Copied modules not drift-checked.** `scripts/check-shared-copies.ts` has no group for estimai-
  api's oversight code or projects-api's authz code, and adding one needs markers inside those apps;
  hours-api registers only in the existing groups (accepted 2026-11-13). *Mitigation:* the copies cite
  their source file in a header comment; a later chore adds the groups.
- **R8 Library components land with one new consumer each.** `SearchPicker` and `ExportButton` are
  shaped by hours-ui while two `CompanyPicker` copies and `ExportYearButton` stay in their apps.
  *Mitigation:* the contracts above cover what the existing copies do (debounce, stale-answer discard,
  status reset); the migrations are listed as follow-up chores in tasks, not done here.

## Security

**Security-sensitive: YES** — schedule the owasp-reviewer in parallel with QE.

- Personal data about workers (what each person worked on, every day) and a read-everyone
  permission; Italian and Swiss rules on monitoring workers (O3, accepted as risk).
- A new resource server with a new authorization path (oversight) and an admin capability, both
  failing closed; IDOR surface on `PATCH/DELETE /time-entries/{id}` (scoped to `sub`, identical
  404). Restore is a write under the same live `time-list:manage` check as retire.
- A new service client and scope (`meetings.hosts.read`), and meetings-api's first `/system/*`
  route — it must answer only `{id, host}` (ADR-0058: no content to any role).
- What hours-api learns with its **own** credential (a meeting's deal) reaches a viewer only with
  their own right to read that deal: `on.deal` carries an id and a name only when `visible`; totals
  merge what the viewer cannot read; the export carries no ids. Reviewer to check
  `src/labels/` and `src/totals/` for that rule.
- `on.id` and `activity.id` of a hidden project, deal or meeting stay in the item (the entry's own
  stored value, which the owner's edit dialog keeps): an oversight holder can tell that two people's
  hidden entries are on the same record, without its name. Reviewer to confirm, or to ask for `null`
  on entries that are not the viewer's own.
- Cross-service bookability checks run as the caller and fail closed; labels follow the viewer's
  own access (AC-4.10). hours-ui's pickers call projects-api, crm-api, meetings-api and
  activities-api from the browser as the person, on existing routes — no new origin, no CORS change.
- The person filter reuses the totals route behind `time-entry:read-all`; the user directory's
  audience is not widened (ADR-0066).
- The export file is built in the browser from data the viewer can already read; no server file.

Surfaces to review: every hours-api route (`src/entries/`, `src/totals/`, `src/lists/`,
`src/oversight/`, `src/labels/`), crm-api resolve `deal`, activities-api `ids`, meetings-api `ids` and
`GET /system/meetings/hosts`, the `hours-api` service client, hours-ui's export.

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
- **ADR-0089 amendment, § 6 "Labels follow the viewer"** (same file; new 2026-11-12) — A fact
  hours-api reads with its own credential (a meeting's current deal) reaches a viewer only together
  with that viewer's right to read the record it names: the id and the name, or neither; and every
  aggregate or export merges what the viewer cannot name into one group per reason (`hidden`,
  `unavailable`, `deal-unknown`). Rejected: one group per unreadable id (rows nobody can tell apart,
  an export that cannot match them without ids, and a service-credential fact handed to someone who
  cannot read it); returning the linked deal's id with a null name (tells the viewer which deal a
  meeting they may not read is linked to). Constrains specs/030's hours on project and deal pages and
  any later consumer of hours totals.
- **ADR-0090** (`docs/adr/0090-hours-ui-ungated-remote.md`) — Hours get their own remote, mounted
  ungated at `/hours` and absent from `TOOLS` (the ADR-0009/0045 shape without a gated half).
  Rejected: an ungated entry in projects-ui (wrong domain; PR #9 rewrites projects-ui), a
  shell-native screen (ADR-0009: no tool logic in the shell), a `TOOLS` entry behind `hours:access`.
