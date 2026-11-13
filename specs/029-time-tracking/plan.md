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
>
> Amended 2026-11-13 for drift found in implementation batch 1 — contract corrections, no AC,
> endpoint or feature added: (1) § Sequences, the `assignees` reference is
> `activity-host.routes.ts:120` (batch-1 review, ahead of T15); (2) § API contracts, activities-api
> `GET /activities?ids=` as T6 built it — one page, never cut, its 422 cases, only owning hosts asked;
> (3) meetings-api `GET /meetings?ids=` as T8 built it — ANDed with the other filters, ≤ 25 raw
> members, its 422 cases, a NUL member absent; (4) § Entries, the **id rule** on every id an entry
> body carries, so a malformed id is hours-api's own 400 and never an owner's 4xx answered as 503
> (T6, T8); (5) a NUL refused as 400 in `note` and in a list `name` (T10). Test rows AC-1.7, 2.1, 2.5,
> 2.7, 2.10 and 3.1 updated; § Errors, R7 and § Security note the consequences.
>
> Amended again 2026-11-13 for a second batch of drift — contract corrections, no AC, endpoint or
> feature added: (6) § Entries, the id rule also covers the path `{id}` of the entry and list routes
> (400 `invalid_request`, `field: "id"`, chosen over a 404) and the six list/totals id filters (400
> naming the filter) — found by the first amendment's review: a NUL would reach hours-api's own
> Postgres (500) and a malformed `dealId` would be forwarded to the system route, whose 422 would read as
> the AC-4.11 503; the rule counts UTF-16 units, the owners' unit; (7) § API contracts, meetings-api
> `GET /system/meetings/hosts` as T9 built it (`host` the stored strings, `?dealId=` unpaged and
> uncapped, its 422 cases, one 401 for every credential failure, `SERVICE_AUDIENCE` optional in
> meetings-api and required by env-doctor, T33), and § Views, a stored host that is not a CRM deal
> counts as no deal; (8) § Components, code references re-pointed after the rebase and batch 1
> (`deals.routes.ts:259`, T7; `list.routes.ts:81-86`, T8; `session.ts:139-178`, T21); (9)
> `src/lib/errors.ts` in hours-api's file list (T10); (10) `note` and a list `name` count Unicode code
> points, as the CHECK's `char_length` does, never zod's UTF-16 `.max()` (T10's CHECK; for T12, T14).
> Test rows AC-1.6, 1.7, 2.6, 3.1, 4.4, 4.5 and 4.11 updated; § Sequences, § Totals, § Errors, § Lists,
> R2, R7 and § Security note the consequences.
>
> Amended a third time 2026-11-13 for a last batch of drift — contract corrections, no AC, endpoint or
> feature added: (11) § Entries, the list's `cursor` is decoded and checked against the exact shape
> hours-api mints, else 400 `invalid_request` with `field: "cursor"`, never a 500, and the order gains `id
> desc` as its last key, without which no cursor walks rows sharing a `createdAt` exactly once (review of
> T10's `errors.ts` and `TIMESTAMP(3)` columns, ahead of T17); (12) a lone surrogate in `note` or a list
> `name` is refused 400 naming the field — the Postgres driver would store U+FFFD in its place (review of
> T10's NUL rule, ahead of T12 and T14); (13) a blank note (`""`, whitespace only) is no note: stored
> `null`, never satisfying `note_required`, which is checked on the entry as it will be stored (spec
> AC-1.7, AC-3.6, A7; ahead of T14); (14) § Views, a deal id read from the system route passes the id rule
> before it joins the crm-api batch, and outside it the meeting's deal is `{ state: "linked", visibility:
> "hidden" }` without touching the page's other deals (T11's `dealOf`, `src/clients/meetings.ts`; ahead of
> T13); (15) § API contracts and R7, how the clients read a list-by-ids answer, as T11 built it: an item
> nobody asked for together with a missing asked id is `unavailable`, never "absent", plus the `?dealId=`
> and deal-scan variants (decisions.md T11 `filter_ignored`, `src/clients/owner.ts` `keepAsked`,
> `activities.ts` `listDealActivities`); (16) § Components and § Test strategy, hours-api's files as built
> (T10: `src/openapi/registry.ts`, `src/test-support/testAuth.ts`, the direnv file written by a person; T11:
> `src/clients/owner.ts`, `hosts.ts` also playing `auth`); (17) § Entries, the `from..to` span counts both
> end days — 366 accepted, 367 and `from` after `to` refused 400 `invalid_request` — the reading T24's
> client already applies (`hours-ui/src/lib/period.ts` `spanDays`, `MAX_SPAN_DAYS`). Test rows AC-1.7, 2.6,
> 2.11, 3.1, 3.6, 4.1, 4.4, 4.5 and 4.7 updated; § Data model, § Sequences, § Views, § Totals, § Errors,
> § Lists, R7 and § Security note the consequences.
>
> Amended a fourth time 2026-11-13, before T14, T17 and T18 — contract corrections, no AC, endpoint or
> feature added: (18) § Entries, "A blank note": `note_required` is checked when a `POST` records an entry,
> or a `PATCH` sends `note` or moves the entry (an `on` other than the stored target), and never on a `PATCH`
> that touches neither — the user's decision D50 (ledger.md), replacing (13)'s "on every `POST` and `PATCH`
> against the entry as it will be stored", which stays recorded as the rejected alternative; (19) § Entries,
> "A day": `day`, `from` and `to` are real calendar days from 2000-01-01 (a `YYYY-MM-DD` that round-trips
> through `Date.UTC` unchanged), else 400 `invalid_request` naming the field — Bun reads `new
> Date("2026-02-30")` as 2026-03-02 and Postgres refuses `'0000-01-01'` (a 500); the span and a cursor's day
> are measured on valid days only (found reviewing amendment 3's cursor and span rules, ahead of T14 and
> T17); (20) § Entries, "The span": its 400 names `field: "to"`, the field hours-ui's Custom period marks
> (`hours-ui/src/lib/period.ts` `rangeErrors`; same review); (21) § Sequences "Admin lists" and § Lists as
> T12 built them (decisions.md T12; `src/lists/lists.routes.ts` `inListOrder`, `src/authz/timeListManage.ts`,
> `src/authz/resolveClient.ts`): `GET /time-lists` orders each list `createdAt asc, name asc, id asc`, and
> `time-list:manage` remembers only a refusal (30 s per `(sub, perm_epoch)`), never a grant and never an
> outage, over a 2 s call to `auth` with `redirect: "error"` — the "projects-api shape" the plan named
> remembers grants too. Test rows AC-1.3, 3.1, 3.3, 3.6 and 4.4 updated; § Components, § Sequences, § Data
> model, § Errors, § Lists and § Security note the consequences.
>
> Amended a fifth time 2026-11-13, after T14 — records of what T14 built where the plan was silent, and
> corrections; no AC, endpoint or feature added (decisions.md § T14; `hours-api/src/entries/entries.routes.ts`
> `validateWrite` and `askOwners`, `rules.ts` `refusal`, `schemas.ts` `UpdateEntrySchema`, `write.test.ts`):
> (22) § Entries, "A change and a move": a `PATCH` is validated against the entry as it will be stored; a
> stored `workTypeId` or `activityId` is carried across a move and must fit the new target (422
> `work_type_not_allowed` / `activity_not_allowed`), never dropped silently, so a client that moves an entry
> sends `null` for what it cleared; the work type an entry already has is never chosen anew — re-sent with the
> target unchanged, or carried, a retired one stays, while a different retired one is 422 `work_type_retired`;
> (23) § Errors: `PATCH {}` is 400 `invalid_request` with `field: ""`, every 422 carries `field` next to `code`,
> and the order of the answers — shape (400), the entry looked up (404) before any rule, the local 422s in a
> fixed order, then the owners; (24) the AC-2.12 test row, § Sequences "Change an entry", the `PATCH` comment
> of § Entries and "A pointed activity that was deleted": a change that keeps the target makes no
> **bookability** call — not "no owner call": the view it returns reads its labels as the viewer through the
> same resolve (T13), which no fake can tell apart, so the proof is the save succeeding while the owner is
> down; (25) § Errors and R11: the 501 `not_implemented` T14 answers for owner-dependent writes is a
> build-order seam, gone at T16; (26) the AC-1.6 row: "byte-identical" 404 bodies once `instance`, which
> echoes the requested path, is set aside (T14's `sameAnswer`). Test rows AC-1.5, 1.6, 2.1, 2.7, 2.12, 3.4
> and 3.5 updated; § Data model, § Sequences, § Errors, § Lists, R11 and § Security note the consequences.
>
> Amended a sixth time 2026-11-13, before QE and the eval — the record of what T15–T20 and T27–T30 built
> where the plan was wrong or silent; no AC, endpoint or feature added (decisions.md § T15–T20 and T27–T30,
> with T11 and T13 where those rely on them;
> `hours-api/src/targets/`, `src/oversight/`, `src/entries/{entries,list}.routes.ts`, `filters.ts`,
> `src/totals/`; `hours-ui/src/lib/hoursWorkbook.ts`, `components/EntryDialogModel.ts`): (27) § Errors, § Entries
> and § Lists, **three 404 bodies, not one**: an entry the caller cannot write and a list item no one has answer
> 404 with **no `code`**, a target missing, unreadable or (a meeting) not the caller's answers 404 `code:
> "not_found"` with one detail naming no kind and no id — each identical across the cases it covers (AC-1.6,
> AC-2.10), and hours-ui tells the entry's from the target's on an edit (T28 `entryIsGone`); (28) § Errors and
> R11: the 501 seam closed at **T19**'s close, not T16's — T17 and T18 answered a transitional 501 for
> `whose=all`, which T19 replaced; `grep -rn not_implemented hours-api/src` prints nothing; (29) § Sequences
> "Oversight", "List / totals" and § Components, as T19 built it: `auth` asked through T12's
> `resolveClient.ts` (2 s, `redirect: "error"`, a strict body), one refusal memory shared by the list, the
> totals and the write guard and separate from `time-list:manage`'s, the order of a read (400s, then the
> oversight check, then the `dealId` call, then the database), `userId` only with `whose=all`, a holder's write
> on a nonexistent id 404; (30) § Errors: `host_unavailable` on a read carries its own `detail` (T19), a 403,
> 404 or 503 carries no `field`, and the list's and the totals' strict query; (31) § Totals as T18 built it:
> `totalMinutes` the sum of the tallied groups, the strict query, ties by the English collator then the key, a
> deactivated person `status: "deleted"` and no outage, two system-route calls for `groupBy=deal` with a
> `dealId` filter, `unavailable` in the `Unavailable` type's order, and what a `dealId` filter adds; (32) § Entries,
> the list as T17 built it: `limit` written plainly, `target` the entry's own target, a cursor's instant
> zero-padded (13 digits span 1970–2286, not 2001–2286), linked meeting ids outside the id rule dropped; (33)
> § API contracts "Reading the owners' list answers": the host resolve's reading (T11, as T15 and T16 rely on
> it), and R9's log line (T16); (34) § Sequences: an activity under a target whose owner did not answer is
> `unavailable` (T13), a project's activity pointer matched by `projectId` alone (T16); (35) § Export file as T30
> built it: the Person cell (T29's `personName`, decisions.md T30), the Activity cell for `unavailable`, the
> walk's stop on a repeated cursor and the file name; (36) § Security: the `dealId` filter as a link oracle (T17,
> T18 notes for T37), the credential-less answers (T20), and `src/targets/` among the surfaces. § Entries "A
> day" and "A change and a move" record T27, T29, T15 and T16. Test rows AC-1.6, 2.10, 4.2, 4.4, 4.5, 4.6 and
> 5.3 updated.
>
> Amended a seventh time 2026-11-13, after the OWASP review (T37) — a decision on the wire contract, made by
> the review as the user delegated it (ledger D44: "keep the id, decide at review"); no AC, endpoint or
> feature added (`owasp-report.md` § F1 and § 4; ADR-0089 A1, "Decided 2026-11-13 (D44): WITHHOLD"): (37)
> § Views, `on.id` (project, deal, meeting) and `activity.id` become `string | null` — returned only when the
> record is `visible` to the viewer or the entry is the viewer's own, else `null` (finding F1: the ids of
> hidden records, fed back as `dealId` / `projectId` / `meetingId` filters, told a read-all holder which hidden
> meetings are linked to which hidden deal) — applied in `src/entries/view.ts`, not `src/labels/**`; `on.deal`,
> the totals, the export, the `none` target and the author's `POST` / `PATCH` responses unchanged; (38)
> § Security, the bullet that left D44 to the reviewer replaced by the decision, its reason and the residual
> of an author's own ids; the four questions the section put to the reviewer answered (the A1 rule confirmed,
> D44 withhold, F2 the `dealId` link oracle accepted, I2 activities-api's outage side channel accepted) and
> the other accepted findings listed (F3–F7, I1, I3–I5); (39) § Sequences "List / totals" step 4 and "A
> pointed activity that was deleted", § Decisions this plan makes and the ADR-0089 bullet of § ADR candidates
> point at the rule. Test rows AC-4.2 (own versus other) and AC-4.10 (the withheld ids and the composition
> test `src/entries/withheldIds.test.ts`) updated. The spec is unchanged: AC-4.10's added words "… and, for
> anyone but its author, without its id" are the review's proposal, for the owner to approve. Built by T41
> (hours-api) and T42 (hours-ui); the review stays REVIEW REQUIRED until T41 is built and re-checked.

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
| `hours-api` (new) | Service skeleton copied from activities-api's shape: `src/index.ts` (CORS with `ALLOWED_ORIGINS`, request logger, 64 KiB body limit, routers, OpenAPI + Scalar mounted from `src/openapi/registry.ts` — public, like `/health` — RFC 7807 `onError`/`notFound`), `src/auth/jwt.middleware.ts` (RS256, issuer, `aud=AUTH_AUDIENCE`), `src/lib/{env,db,problem,errors,logger,identities,serviceToken}.ts` (`errors.ts`, T10: `invalidRequestHook`, which answers any schema violation — body, query, path parameter, malformed JSON — 400 `invalid_request` naming the field, plus `handleError` / `handleNotFound` for `onError` / `notFound`; kept outside the shared `problem` copy, whose own `validationHook` answers 422), `src/health`. Feature modules (as built; amended a sixth time 2026-11-13): `src/entries/` (`entries.routes.ts` the writes, `list.routes.ts` the list and its cursor, `filters.ts` the query the list and the totals share, `rules.ts` the local rules and the day rule, `schemas.ts`, `today.ts`, `view.ts`), `src/totals/` (`totals.routes.ts`, `totals.ts`, `groups.ts`), `src/lists/` (categories, work types; `idRule.ts`, the id rule's one home, which `src/labels/idRule.ts` re-exports), `src/targets/` (T15, T16: `bookability.ts`, `activity.ts` — the activity pointer — and `errors.ts`), `src/labels/` (fail-soft names and meeting→deal links), `src/oversight/` (read-all, T19: `oversight.ts`, adapted from estimai-api `src/estimates/oversight.ts` but asking `auth` through `src/authz/resolveClient.ts`, not estimai-api's `src/lib/authClient.ts`; `scope.ts`, whose `EntryScope` is one person's or everyone's, and only the oversight check hands out everyone's; `errors.ts`), `src/authz/` (live `time-list:manage`, T12: `timeListManage.ts`, adapted from projects-api `src/auth/authz.middleware.ts` but remembering only a refusal, and `resolveClient.ts`, adapted from projects-api's with a 2 s timeout and `redirect: "error"`; § Sequences, "Admin lists"). Clients (T11): `src/clients/owner.ts`, the one HTTP adapter they share — only a clean 200 with a JSON body is an answer, 2 s, `redirect: "error"`, batches of the owner's cap with at most four in flight, `keepAsked` (§ API contracts, "Reading the owners' list answers") — and `src/clients/{projects,crm,activities,meetings}.ts` (caller JWT, batched; meetings system call with a service JWT). Copied modules registered in `scripts/check-shared-copies.ts` where a group exists (R10). Test harness: `src/test-support/env.ts` (the `bun test` preload: a `_test` database, dead placeholder URLs for every other service), `testAuth.ts` (T10: mocks `jwt.middleware`, signs any token a test needs — another `aud` or issuer, an expired one), `world.ts` (T10: the assembled app, personas, direct inserts of an entry on every target, `onReset`) and `hosts.ts` (T11, activities-api pattern: one scriptable `Bun.serve` playing projects-api, crm-api, activities-api, meetings-api — its list and its system route — and `auth`'s `/authz/resolve`, `/authz/users/identities` and `/system/service-token`; a failure per route, `sever`, the pre-T6–T9 `legacy` owners of R7, every call recorded), `src/matrix.test.ts` and `src/openapi.contract.test.ts` (T20). Env (`src/lib/env.ts`): `DATABASE_URL`, `ALLOWED_ORIGINS`, `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_BASE_URL`, `PROJECTS_API_URL`, `CRM_API_URL`, `ACTIVITIES_API_URL`, `MEETINGS_API_URL`, `SERVICE_CLIENT_ID`, `SERVICE_CLIENT_SECRET`, `SERVICE_AUDIENCE` (≠ `AUTH_AUDIENCE`), `PORT=8088`, `NODE_ENV`. Files: `.env.example`, `.envrc` (written by a person — agents may not create it, T10 open item), `.gitignore`, `Dockerfile`, `bunfig.toml`, `package.json`, `prisma.config.ts`, `railway.json` (`preDeployCommand: bun run db:deploy`), `tsconfig.json`. |
| `activities-api` | `GET /activities` accepts `ids` (≤ 50, comma-separated) as a fifth "exactly one of" filter. Each id's host is resolved **as the caller**, exactly as today; unreadable or missing ids are omitted (identical); an unreachable host is the existing 503. No new table, no catalog. |
| `crm-api` | `src/activity-host/resolve.routes.ts`: `entityType` becomes `"company" \| "deal"`. For `deal` each id is answered with label/href and `involved: [ownerUserId, technicalUserId?]`, the technical contact taken **as the deal view does** (`estimate?.technical` — an override row with `estimateId: ""` is not a technical contact, `deals.routes.ts:259`). Reader = `crm:access`, as for companies. |
| `meetings-api` | (1) `GET /meetings` gains `ids` (≤ 25) — still the caller's own meetings only (creator or Operai participant, `list.routes.ts:81-86`), so one call is both the booking check and the label. (2) First `/system/*` route, `GET /system/meetings/hosts` (service JWT, `aud=SERVICE_AUDIENCE`, scope `meetings.hosts.read`, sub `system:hours-api` only, one identical 401), answering `{id, host}` and nothing else, `host` as the meeting stores it (the contract as T9 built it: § API contracts). Copies crm-api's `src/auth/systemAuth.middleware.ts` (verifies against the existing `AUTH_JWKS_URL`). Env: `SERVICE_AUDIENCE`, **optional** in meetings-api's `env.ts` (unset: every system call is the one 401, so a deploy that precedes the variable fails closed instead of stopping the service, T9) and **required** by env-doctor's production contract (T33). |
| `auth` | New catalog `auth/src/authz/catalogs/hours.ts`, appId `hours`, **no `access` resource** (the feature is ungated, AC-5.1): `time-entry:read-all` and `time-list:manage`, both `supportedConditions: []`. `seed.ts`: `DECLARED_CATALOGS`, `seedHoursCatalog`, `seedHoursGrants` (admin only, unconditioned); **not** in `ALL_APP_IDS`. `uniqueResourceKeys.test.ts` appId list; `seed.test.ts` block. `system/serviceClients.ts`: `KNOWN_SERVICE_SCOPES += "meetings.hosts.read"`; documented client `hours-api` with that scope. Not added to `DIRECTORY_GATE_PERMISSIONS`: the person filter's options are the `person` groups of `GET /time-entries/totals` (§ Totals), so the user directory's audience is not widened (ADR-0066 untouched). |
| `hours-ui` (new) | Federated remote, dev port **5184** (5182/5183 are the e2e preview defaults of meetings/projects in `shell/playwright.config.ts`), e2e preview 5185. Exposes `./App` (ungated, the whole hours screen) and `./version` (ADR-0030). Screens (`design.md`): My hours (period list grouped by day; **each day's total comes from `GET /time-entries/totals?groupBy=day`** with the list's filters, so a day whose entries straddle two cursor pages shows its full total at once — no client-side sum, no "so far"), the entry dialog (target picker, category / work type, activity, note), the global view for holders of `time-entry:read-all` (person filter, grouped totals, export). **Session imports** declared in `src/federation/remotes.d.ts` and the test stub: `apiFetch`, `usePermissions`, `getHoursApiBaseUrl` (T21, `shell/src/lib/session.ts:185`) and the existing `getProjectsApiBaseUrl`, `getCrmApiBaseUrl`, `getMeetingsApiBaseUrl`, `getActivitiesApiBaseUrl` (`shell/src/lib/session.ts:139-178`); those four origins are already trusted by `apiFetch` and already allow the shell origin (`tools/env-doctor/manifest.ts` `CORS_REQUIREMENTS`), so no backend CORS change. **Target pickers** (`SearchPicker`) search what the person can already search, as the caller — projects-api `GET /projects?q=`, crm-api `GET /deals?q=`, meetings-api `GET /meetings?q=` (the caller's own meetings); a 403 maps to the picker's `forbidden` state, a 503 or network failure to `unavailable`; the server decides bookability. **Activity picker**: once a project or deal is picked, the browser calls activities-api as the caller, `GET {getActivitiesApiBaseUrl()}/activities?projectId=<id>&pageSize=100` or `?dealId=<id>&pageSize=100` (`MAX_PAGE_SIZE` 100, activities-api's own order `occurredAt` desc; one page, a "latest N" hint when `total > items.length`; an edited entry's current activity stays an option from its view). A 404 (project or deal not readable through activities-api), 503 `host_unavailable` or a network failure is the picker's error state; the field is optional, so Save stays enabled, and the save is checked by hours-api's own rules (422 `activity_not_allowed`, 503 `host_unavailable`), never by what the picker showed. Rejected: listing activity options through hours-api (a second list contract for a read the person can already make, and hours-api would forward the same JWT anyway). **Person filter** options: the `person` groups of `GET /time-entries/totals?whose=all&groupBy=person` with the view's other filters and **without** `userId` (§ Totals). **Export**: `ExportButton` (`@operai/ui`) + `buildHoursWorkbook(items, copy)` in `src/lib/hoursWorkbook.ts`, `exceljs` lazy-loaded inside `build`, rows from every page of `GET /time-entries` (`limit=500`) with the active filters (inventory-ui `yearWorkbook.ts` pattern); duration as one numeric decimal-hours column and a "Counts for deal" column (§ Export file, D39, D40). `@operai/ui` throughout. |
| `shell` | `getHoursApiBaseUrl()` in `src/lib/session.ts` (`VITE_HOURS_API_URL`, trusted origin, `vite-env.d.ts`, `.env.example`). Ungated splat route `/hours/$` (child of `shellRoute`, no `beforeLoad`, the `/my-meetings` shape); **not** a `TOOLS` entry. UserMenu link "My hours". Runtime remote `hours` (`runtimeRemotes.ts`, `runtime-config.example.json`, `vite.config.ts`, `federation/remotes.d.ts`, stubs), About-modal version, `index.css @source`, Vercel CSP (`script-src`, `connect-src`), strings en/it. |
| `admin-ui` | Page `/time-lists` (`design.md` S5): three cards — categories (name, requires note, status) and the two work-type lists. Row actions: **Rename**; **Retire** on an active row, **Restore** on a retired row (each one `PATCH … { retired }`, AC-3.1 as amended, D38). `src/lib/timeListsApi.ts` via `apiFetch` + `getHoursApiBaseUrl` (added to `federation/remotes.d.ts` and the stub). Nav entry shown only with `time-list:manage` (`SectionNav.tsx`, the `rate:read` pattern); a 403 renders `PermissionDenied`. admin-ui is the gated Admin tool (`shell/src/lib/tools.ts` entry `admin`), so reaching the page needs Admin access **and** `time-list:manage`, while hours-api's gate is `time-list:manage` alone: a role given the permission without Admin access can call the API but cannot reach the screen (AC-3.3 as amended, D41; the mileage-rate pattern, ADR-0023). |
| `@operai/ui` | Four additions, each with a story and a test, exported from `src/index.ts` with their prop types; changeset `@operai/ui` minor. (1) `formatDuration` gains `style: 'short'` → "2 h 30" / "2 h" / "30 min" (AC-4.9; the `DurationStyle` union in `src/lib/format.ts`; story in `src/foundations/Formatting.stories.tsx`, test in `src/lib/i18n-format.test.tsx`). (2) `formatMonth` (same files) for the by-month totals, whose keys are `YYYY-MM`: "November 2026" / "novembre 2026". (3) **`SearchPicker`** (`src/components/SearchPicker.{tsx,stories.tsx,test.tsx}`): a `Field`-wrapped `Combobox` for a **server-side** search — debounce, abort and discard of stale answers, picked never typed (typing after a pick clears it), `emptyState` for searching / no match / forbidden / unavailable, the result count announced. hours-ui is its third consumer after `crm-ui/src/components/CompanyPicker.tsx` and `projects-ui/src/components/CompanyPicker.tsx`, which migrate later (not in this spec). (4) **`ExportButton`** (`src/components/ExportButton.{tsx,stories.tsx,test.tsx}`): the download button of `inventory-ui/src/components/ExportYearButton.tsx` — `aria-busy` not `disabled`, a second click ignored, polite "preparing / ready" status, a failure alert, the object URL revoked — with hours-ui as the second consumer (AGENTS.md: a pattern a second app needs goes into the library); inventory-ui migrates later. Contract sketches in § API contracts. `docs/design-system.md` (§ Suggestions while typing) and `docs/decisions.md` (next free D-numbers) record the two components. Rejected: a local `ExportEntriesButton` in hours-ui (`design.md`'s fallback — a second copy of an app pattern, which AGENTS.md forbids); `PersonPicker` for the target pickers (it filters an already loaded list client-side). |
| Infra / release | `infra/provision-tool.sh hours` (the standard api + ui pair: Railway service `hours-api`, database `hours`, Vercel project `hours-ui`, DNS), `infra/check.sh` (health + 401 probes), `infra/README.md` section; `compose.yaml` service; `mise.toml` (`dev`, `dev:web`, `dev:preview`, `db:migrate`); `tools/env-doctor/manifest.ts` (`SERVICES`, `ORIGINS`, `resourceServers`, `AUTH_*` links, `CORS_REQUIREMENTS` hours-api `mustAllow: ["shell", "admin-ui"]`, `REQUIRED_KEYS`, `INTERNAL_URL_VARS` for the four internal URLs, `SERVICE_CLIENT_LINKS` hours-api `["meetings.hosts.read"]`, meetings-api `SERVICE_AUDIENCE`) + `templates/production/hours-api.env` + its tests; `lerna.json` (`hours-api`, `hours-ui`); changesets (auth, hours-api, hours-ui, activities-api, crm-api, meetings-api, shell, admin-ui, operai-ui — the last one minor, for the four additions above); `AGENTS.md`, `README.md`. |

### Sequences

**Record an entry on a deal** (`POST /time-entries`, `on: {type:"deal", id}`):
1. hours-ui → hours-api with the user's JWT.
2. Validate shape (the id rule, and a note free of NUL and lone surrogates, § Entries), duration, day
   (today in `Europe/Zurich`), note (a blank one is none), category / work type (local).
3. hours-api → crm-api `POST /activity-host/v1/resolve {entityType:"deal", ids:[id]}` with the
   caller's JWT. `reader:false` or `missing` → **404**; unreachable → **503**.
4. Involved if the caller is in `item.involved`; otherwise hours-api → activities-api
   `GET /activities?dealId=<id>` (caller's JWT, paged, ≤ 10 pages) and looks for the caller as a
   task's assignee or in `participants`. Neither → **403 `not_involved_in_deal`**; activities-api
   unreachable, or a scan that cannot account for every activity → **503** (§ API contracts, "Reading
   the owners' list answers").
5. If `activityId`: activities-api `GET /activities?ids=<activityId>` — absent, or its `deal.id`
   ≠ the deal → **422 `activity_not_allowed`**; an answer that ignored the filter → **503**.
6. Insert; 201 with the view.

**On a project**: step 3 is projects-api `POST /activity-host/v1/resolve {entityType:"project"}`;
the caller must be in `assignees` (PM + team, `projects-api/src/activity-host/activity-host.routes.ts:120`;
a project from a deal still awaiting its PM answers its team only) → else **403
`not_on_project`**. `writable` (false when closed/cancelled) is **ignored**: entries are accepted
in any state (A12). An activity pointer must be an activity whose `project.id` is that project; a
project's activities are tasks only, so no type is checked (T16, `src/targets/activity.ts`).

**On a meeting**: meetings-api `GET /meetings?ids=<id>` with the caller's JWT (selfScoped, works
through an `auth` outage). Absent → **404** (also covers a host-only reader, whom the list never
includes); an answer that ignored `ids` → **503**, never 404. No activity pointer, no work type.

**On no entity**: no remote call; category required; a note when that category requires one
(`note_required`, checked as D50 says: § Entries, "A blank note").

**Change an entry** (`PATCH`; amended a fifth time 2026-11-13, as T14 built it): the entry is looked up
for the caller first (404, before any rule; § Errors, "Order of the answers"), and the request is then
validated against the entry **as it will be stored** — each member sent, else the stored one (§ Entries, "A
change and a move"). The steps above run only when `on` moves the entry to a different target (D46,
AC-2.12). A change that keeps the target re-validates the local rules (step 2: duration, day, note, category
/ work type against the stored target) — `note_required` only when the `PATCH` sends `note` (D50; § Entries,
"A blank note") — and, for a new `activityId`, step 5 alone; it makes **no bookability call** otherwise. The
view it returns still reads its labels as the viewer, fail soft, like any read (T13; step 4 of "List /
totals") — through the same resolve, so what proves that no bookability call was made is the save succeeding
while the owner is down, never a count of the owner's calls (AC-2.12 test row). A change that moves the entry
runs the new target's steps, `note_required` included, with the stored work type and activity carried to the
new target unless the `PATCH` sends them (step 5 for a carried activity). *Rejected:*
re-checking bookability on every change (the plan's first reading of A3) — an author who left a team could
then only delete an entry to correct it, losing the hours, while delete already needs no check.

**List / totals** (`GET /time-entries`, `GET /time-entries/totals`):
1. `whose=mine` (default): JWT only, scoped to `sub`. `whose=all`: oversight (below). What the
   request alone decides is decided first — its shape, the period, `userId` only with `whose=all`, then
   the cursor — and a 400 calls nobody; then whose entries (the oversight check: 403, 503); then step 2;
   then the database (amended a sixth time 2026-11-13, as T19 built it). So a caller refused `whose=all`
   never makes hours-api ask meetings-api anything, and with `auth` down a `whose=all` read with a
   `dealId` filter is 503 `authz_unavailable`, never `host_unavailable`.
2. A `dealId` filter first asks `GET /system/meetings/hosts?dealId=` for the meetings currently
   linked to that deal, so their entries match too (AC-2.6); only answered items whose `host` is
   exactly that CRM deal count, and an answered meeting id outside the id rule is left out of the
   query — an entry's meeting id passed the rule when it was written, so no entry is lost, and no NUL
   reaches Postgres (T17, `filters.ts` `dealCondition`). A filter outside the id rule never gets here:
   it is a 400 first (§ Entries). When that route does not answer, the whole read is refused with 503
   `host_unavailable` and nothing partial is returned (AC-4.11, D45; § Totals, "When the meeting →
   deal link is unavailable").
3. Query entries (SQL; indexes `userId, day`, `projectId, day`, `dealId, day`, `meetingId`) in the order
   `day desc, createdAt desc, id desc`, after the position a valid `cursor` names (§ Entries, "The cursor").
4. In parallel, fail soft, each source named in `unavailable[]` when it does not answer:
   identities (`identities`; `auth POST /authz/users/identities`, ≤ 100), project labels
   (`projects`; projects resolve, 25), deal labels (`crm`; crm resolve `deal`, 25 — the deals of the
   page's deal entries **and** the deals its meetings are linked to, each of the latter checked against
   the id rule first, § Views), pointed activities
   (`activities`; activities-api `GET /activities?ids=`, 50), meeting titles (`meetings`;
   `GET /meetings?ids=`, 25 — only meetings the **viewer** took part in), meeting → deal links
   (`meeting-deals`; `GET /system/meetings/hosts?ids=`, 100). Labels follow the **viewer's** access
   (AC-4.10): an entity the viewer cannot read is `visibility: "hidden"`, label `null`, and the
   activity subject is `null`; on an entry that is not the viewer's own, `on.id` and `activity.id` are
   `null` too unless `visible` (D44; § Views, "Ids of what the viewer cannot read"). Totals ask only the
   sources their grouping needs (§ Totals).
5. Grouping by deal places a meeting's entries under its current deal (AC-2.6); a meeting whose
   link could not be read goes to the `deal-unknown` group.

**A pointed activity that was deleted** (AC-2.9) is derived on read, not swept (ADR-0013): when
the viewer can read the entry's project or deal and activities-api no longer returns the pointed
id, the view shows `activity: null`; when the project or deal itself is hidden from the viewer the
activity is shown as hidden too (AC-4.10); when the project's or deal's owner did not answer, the activity
is `{ id, subject: null, visibility: "unavailable" }` (`id: null` on an entry that is not the viewer's own,
D44) whatever activities-api said, and `activities` is named
only when its own call failed (T13, `src/labels/resolve.ts`). The stored id is **never cleared** — not on
read, not on a later write (D47): activities-api omits an id the caller cannot read exactly like a deleted one, so
clearing it on a write would drop a live pointer for an author who merely lost read access, and a
`PATCH` that keeps the target makes no bookability call (AC-2.12). A changed `activityId` is validated
as in step 5, and so is one carried across a move (§ Entries, "A change and a move"). *Rejected:* reconcile
on write (loses live pointers, needs an owner check on every keep-target `PATCH`); clearing only after the host confirms the author still reads the target (an extra call
for a cosmetic cleanup). A dangling id costs one text column.

**Oversight** (`whose=all` — a `userId` filter travels only with it, else 400 — and any write on
someone else's entry; amended a sixth time 2026-11-13, as T19 built it, `src/oversight/`): hours-api asks
`auth GET /authz/resolve` with the caller's JWT for `time-entry:read-all`, through T12's
`src/authz/resolveClient.ts` (2 s, `redirect: "error"`, a body that is not a permission list is no answer);
any grant of the pair counts (the catalog declares no conditions). A refusal is cached by
`(sub, perm_epoch)` for 30 s, a grant never (ADR-0075), an outage as neither; that memory is shared by the
list, the totals and the write guard, and is not `time-list:manage`'s — a refusal of one permission refuses
nothing of the other. `auth` unreachable → 503 `authz_unavailable` on reads (before the `dealId` call, step 1
above). On a write the check runs only once the lookup of the caller's own entry came back empty — a person's
own writes never ask `auth` — and only decides 403 `owner_only` (a holder, and the entry exists) vs 404: a
failed check, a missing permission and a nonexistent id are all the 404, while a database that cannot answer
stays a 500. *Rejected:* estimai-api's `src/lib/authClient.ts`, the source this plan first named for the call
(it waits 5 s and follows redirects, replaying the Bearer to another host).

**Admin lists** (amended a fourth time 2026-11-13: as T12 built it, `src/authz/timeListManage.ts` and
`resolveClient.ts`): `time-list:manage` is resolved live from `auth GET /authz/resolve`, with the caller's
JWT, on every list write — create, rename, retire and restore alike — by route middleware that runs before
the body and the path are validated. Only a **refusal** is remembered, 30 s per `(sub, perm_epoch)`; a
grant is never remembered, so a revoked holder is refused on the very next write even while their token
still carries the old epoch; an outage is remembered as neither. The call has a 2 s timeout (R2) and
`redirect: "error"` (following a redirect would replay the Bearer to another host). No grant of the pair →
403 `time_list_manage_required` (any grant counts: the catalog declares no conditions); a non-2xx, a
timeout, a redirect, a network error or a body that is not a permission list → 503 `authz_unavailable`,
nothing changed. Reading the lists needs only a JWT. *Rejected:* projects-api's `authzMiddleware` as it is,
the shape this plan first named — it remembers a grant too, so a revoked holder could keep writing for up
to 30 s (the gap estimai-api's security review of 2026-11-09 closed for ADR-0075's oversight), and its
call waits 5 s and follows redirects.

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
- **An id the viewer cannot read travels only on their own entries** (D44, decided by the OWASP review
  2026-11-13): `on.id` and `activity.id` are `null` on someone else's entry unless the record is `visible`
  (§ Views, "Ids of what the viewer cannot read"; ADR-0089 A1).

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
belongs to the same project/deal, no retired category or work type chosen on create or change (the one an
entry already has is not chosen anew: § Entries, "A change and a move"), a
category's `requiresNote` (when D50 checks it), no future day, a blank note stored as `null` (§ Entries,
"A blank note"). A `day` is also a real calendar day from 2000-01-01 (§ Entries, "A day"), checked in code
before the database is asked; that floor would fit a CHECK, but none is added: the init migration is
written, and the 400 always answers first.

No schema change in activities-api, crm-api, meetings-api or projects-api. No data migration.
Restore (D38) needs no schema change: it clears `retiredAt`.

## API contracts

All hours-api routes: Bearer JWT (`aud=AUTH_AUDIENCE`), RFC 7807 Problem JSON with `code`. Dates
`YYYY-MM-DD`; a date hours-api receives is a real calendar day from 2000-01-01 (§ Entries, "A day"). Base
URL `getHoursApiBaseUrl()`.

### Views

```ts
type Person = { id: string; name: string | null; status: "active" | "deleted" | "unknown" }
type Visibility = "visible" | "hidden" | "unavailable"   // hidden: the viewer may not read it (AC-4.10)

type TimeEntryView = {
  id: string
  day: string                       // YYYY-MM-DD
  minutes: number
  note: string | null               // null: no note; never blank (§ Entries, "A blank note")
  person: Person
  on:
    | { type: "project"; id: string | null; label: string | null; href: string | null; visibility: Visibility }
    | { type: "deal"; id: string | null; label: string | null; href: string | null; visibility: Visibility }
    | { type: "meeting"; id: string | null; label: string | null; href: string | null; visibility: Visibility;
        deal: MeetingDeal }
    | { type: "none"; category: { id: string; name: string; retired: boolean } }
  workType: { id: string; name: string; retired: boolean } | null
  activity: { id: string | null; subject: string | null; visibility: Visibility } | null // null: none, or deleted
  // on.id, activity.id: null only on an entry that is not the viewer's own, when the visibility next to the
  //   id is not "visible" (D44; "Ids of what the viewer cannot read", below)
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
crm-api resolve `deal` batch, sent with the **viewer's** JWT. `host` is whatever the meeting stores,
three strings (T9; ADR-0059: a host is data, never a branch), so hours-api's client accepts any strings
and decides per item: a `host` other than exactly `app: "crm"`, `entityType: "deal"` — another host,
which production does not have (specs/021 AC-11.1) — counts as **no deal**, like `null`:
`{ state: "none" }`, the `none` group of `groupBy=deal`, its `entityId` never sent to crm-api and never
shown, `meeting-deals` not named in `unavailable`, and the batch's other meetings unaffected. Only an
answer that is not the route's shape (not JSON, `items` or a `host` malformed) is `unavailable` (R7).
*Rejected:* the literal `crm` / `deal` schema the plan first wrote for `host` (one unexpected host would
fail the whole batch, and every meeting of the page would read `unknown`); `deal-unknown` for such a
meeting (it says "could not ask" when meetings-api did answer). The deal's visibility is the viewer's
access to the **deal** (AC-4.10), independent of their access to the meeting: `reader:false` or
`missing` → `hidden`; crm-api not answering → `unavailable` (source `crm`). The id is returned only
with `visibility: "visible"`: the link was read with hours-api's own credential, and a viewer who
cannot read the deal must not learn which deal a meeting is linked to (ADR-0058, ADR-0089). The
system route not answering → `{ state: "unknown" }` and `meeting-deals` in `unavailable`; the entry is
still listed and counted (AC-4.7). *Rejected:* a flat `meetingDeal` member on every view (null on
three targets of four) and the earlier `deal: {…} | null` (cannot tell "no deal" from "could not
ask", which the export and the by-deal totals must keep apart).

**A deal id read from the system route passes the id rule** (amended a third time 2026-11-13; T11's
`dealOf`, for T13). meetings-api bounds an `entityId` when it links (`HostRefSchema`: trimmed, 1..64), but
the route answers what is stored (T9), and the client keeps any non-empty `entityId` of a `crm` / `deal`
host. crm-api refuses a whole resolve batch with 422 when one id is outside its bound (1..64, no NUL), and
hours-api must read that 422 as `unavailable` (R7): one stored value would make every deal of the page
`unavailable`. So before a meeting's deal id joins the batch, the labels layer (`src/labels/`, which the
list and the totals share) applies the id rule (§ Entries). Outside it — 65 characters, a NUL, a comma, whitespace at either end — the id is never sent to
crm-api and the meeting's deal is `{ state: "linked", visibility: "hidden" }`: the `hidden` group of
`groupBy=deal`, "Not visible to you" in the export, `crm` not named for it, the same whether crm-api
answers or not, and the page's other deals unaffected. That is the answer crm-api gives for a deal it does
not hold (`missing` → `hidden`, above), and no CRM deal has such an id. An **empty** `entityId` names
nothing and stays no deal, `{ state: "none" }` (`dealOf` as T11 built it). Every other id a read sends — a
project, deal, meeting or activity id stored on an entry — passed the id rule when it was written.
*Rejected:* `{ state: "none" }` (meetings-api says the meeting is linked to a CRM deal; "no deal" would take
its hours out of the deal totals as if it were unlinked); sending it and reading the 422 as `unavailable`
(one stored value fails every deal on the page); `unavailable` for that meeting alone (says crm-api did not
answer when it was never asked).

**Ids of what the viewer cannot read** (amended a seventh time 2026-11-13: ledger D44, decided by the OWASP
review — `owasp-report.md` § F1 and § 4; ADR-0089 A1, "Decided 2026-11-13 (D44): WITHHOLD"). An entry's own
target and activity pointer are stored by hours-api when the author records the entry, not read with its
service credential, so the rule above for `on.deal` did not reach their ids. It does now:
- `on.id` — project, deal or meeting — is the stored id when `on.visibility` is `"visible"` **or** the entry
  is the viewer's own; otherwise `null`. *Own* means `row.userId` equals the caller's verified `sub`, whatever
  `whose` says: a holder of `time-entry:read-all` listing `whose=all` keeps the ids on their own rows.
- `activity.id` follows the same rule with the activity's own `visibility`: on someone else's entry it is
  `null` whenever the activity is not `"visible"` — its project or deal is `hidden` or `unavailable`, or
  activities-api did not answer (`activity.visibility: "unavailable"`, R6). `activity` itself stays an
  object, so a hidden or unanswered pointer is still told apart from one that is gone (`activity: null`,
  AC-2.9).
- The author keeps both ids on their own entries whatever the visibility, `unavailable` included: they chose
  the target when they recorded it, and the edit dialog re-picks it (`hours-ui/src/components/EntryDialogModel.ts`
  `valuesOf`, `sameTarget`). A `visible` record keeps its id for every viewer: they can read it, and its
  `href` already carries the id.
- Unchanged: `label` and `href` (already `null` unless `visible`); `on.deal` (the rule above — an id only with
  `visible`, for every viewer, the author included, D43); the `none` target's `category.id`, `workType.id`
  (hours-api's own lists), `person.id` and the entry's own `id`; the totals (a `keyed` group's key is a record
  the viewer reads, the rest is merged, § Totals); the export (no ids, § Export file); and the `POST` /
  `PATCH` responses, which are always the author's own entry.
- **Where it is applied:** `src/entries/view.ts`, the one module that sees both the viewer and the row's
  author. `toView(row, labels, viewerId)` and `viewEntries(authorization, rows, viewerId)` set `on.id` and
  `activity.id` to `own || <its visibility> === "visible" ? id : null`, with `viewerId` = `c.get("userId")`
  at the three call sites (`entries.routes.ts` `POST` and `PATCH`, `list.routes.ts` `GET /time-entries`).
  `TimeEntryViewSchema`'s `id` becomes `z.string().nullable()` in `on` (project, deal, meeting) and in
  `activity`, and the OpenAPI follows. **Not** in `src/labels/**`: the labels layer is shared with the totals,
  labels one id at a time and knows no author, so it keeps returning what it returns today; `src/totals/**`
  is unchanged. (T37's text named `src/labels/**`; the review moved the strip to `view.ts`.)
- **hours-ui** (T42): `on.id` and `activity.id` are typed `string | null` (`src/lib/hoursApi.types.ts`). The
  only reader of either id is the edit dialog, which My hours opens on the person's own entries — Everyone's
  hours offers no edit — so both ids are always present there; it narrows at that boundary (`valuesOf`, and
  the stored activity `EntryDialog` hands to `ActivityField` as `current`), a `null` read as nothing to
  re-pick. Everyone's hours and the export read no id (`src/lib/names.ts`, `src/lib/hoursWorkbook.ts`): no
  screen changes.

*Why:* with the ids kept, a holder of `time-entry:read-all` without `crm:access` fed a hidden deal's id back
as the `dealId` filter and got exactly the entries on the hidden meetings linked to it, with their ids —
which hidden meetings are linked to which hidden deal, the disclosure A1 forbids, reached through ids rather
than names — and `projectId` / `meetingId` gave per-record figures that `groupBy` merges into one `hidden`
group by design (F1, Medium; § Security). Withholding closes the three pivots at once, at no product cost.
*Rejected:* keeping the ids and asking crm-api as the viewer on every `dealId` filter (a new call and a new
refusal, and the `projectId` / `meetingId` pivots stay open); `null` for the author too (uniform with D43's
name rule, but it breaks the author's edit dialog for no gain — the author already knows their own targets).
AC-4.10's wording "… and, for anyone but its author, without its id" is the review's proposed spec
amendment, for the owner to approve; this plan does not change the spec.

### Entries

```
POST /time-entries
  body: {
    day: string, minutes: number,      // day: "A day" (below), else 400 `field: "day"`; after today → 422
    on: { type: "project" | "deal" | "meeting", id: Id } | { type: "none", categoryId: Id },
    workTypeId?: Id | null, activityId?: Id | null, note?: string | null   // note: no NUL, no lone
                                       //   surrogate; blank = none (below)
  }                                    // strict: any other key (userId, start, end…) → 400
  // Id = string: 1..64 characters, no NUL, no comma, no whitespace at either end (the id rule, below)
  201 TimeEntryView

PATCH /time-entries/{id}               // owner only; any subset of POST's members, at least one (`{}` → 400
                                       // `invalid_request`, `field: ""`); `on` replaced whole; checked against
                                       // the entry as it will be stored ("A change and a move", below)
  200 TimeEntryView                    // bookability (AC-2.2/2.3/2.5) is checked only when `on` is sent and
                                       // differs from the stored target; a PATCH that keeps the target
                                       // (day, minutes, note, workTypeId) makes no bookability call, so it
                                       // succeeds on a project/deal the author left or cannot read (AC-2.12,
                                       // D46) — the view it returns still reads labels as the viewer, fail
                                       // soft. A new `activityId`, or a stored one carried across a move, is
                                       // still checked (AC-2.7: 422 `activity_not_allowed`, 503 when
                                       // activities-api does not answer); `activityId: null` is never
                                       // checked. `on` equal to the stored target counts as unchanged.

DELETE /time-entries/{id}              // owner only; no bookability check
  204
  // PATCH and DELETE: an {id} outside the id rule → 400 invalid_request, `field: "id"`, for every
  //   caller, before any lookup or `auth` call (below)

GET /time-entries?whose=mine|all&from&to&userId&target&projectId&dealId&meetingId&categoryId
                 &workTypeId&cursor&limit
  // from/to required, each a real calendar day from 2000-01-01 ("A day", below), else 400 naming it;
  //   span ≤ 366 days counting both end days, else 400 `field: "to"` ("The span", below); limit 1..500
  //   (default 100) written plainly — digits, no sign, exponent or leading zero; empty or repeated → 400
  //   `field: "limit"` (T17); order day desc, createdAt desc, id desc; `nextCursor` null on the last page
  // strict: a member the route does not name (`projectID=`, `groupBy=`) → 400 invalid_request, `field: ""`
  // target: the entry's own target — a meeting entry is `meeting`, whatever deal it is linked to (T17)
  // cursor: a `nextCursor` as returned; anything else — sent empty or twice included — → 400
  //   invalid_request, `field: "cursor"` ("The cursor", below)
  // userId only with whose=all; dealId includes entries on meetings linked to that deal
  // userId, projectId, dealId, meetingId, categoryId, workTypeId: the id rule (below), else 400
  //   invalid_request naming the filter; a filter sent empty (`projectId=`) or twice is outside it
  200 { items: TimeEntryView[]; nextCursor: string | null; unavailable: Unavailable }
```

**The span** (amended a third time 2026-11-13, for T17 and T18; T24 built the client this way). The
period of the list and of the totals is `from..to` with **both end days included**: its length in days is
`to − from + 1`, so `from = to` is one day. At most 366 days are accepted — a whole leap year
(`2028-01-01..2028-12-31`) or a year and a day (`2026-01-01..2027-01-01`) — and 367 or more (`2026-01-01..
2027-01-02`), or `from` after `to`, is 400 `invalid_request` with **`field: "to"`** (amended a fourth time
2026-11-13), before any `auth`, owner or database call. The span is measured only between two valid days
("A day", below). hours-ui's Custom period counts the same way (`hours-ui/src/lib/period.ts`: `spanDays`,
`MAX_SPAN_DAYS = 366`) and shows both errors on To (`rangeErrors`: `before-from`, `too-long`), so it never
sends a span the server refuses. *Rejected:* an exclusive count (`to − from ≤ 366`, which accepts 367
calendar days and disagrees with the client by one day); `field: "from"` (the client marks To); an empty
`field`, what a refinement over the whole query names by default (T10's hook), which no client can put on a
field.

**A day** (amended a fourth time 2026-11-13, for T14, T17 and T18). Every date hours-api receives — `day`
in `POST` and `PATCH` bodies, `from` and `to` on the list and the totals — is a **real calendar day from
2000-01-01**: exactly `YYYY-MM-DD` in ASCII digits, such that `new Date(Date.UTC(y, m − 1,
d)).toISOString().slice(0, 10)` gives the same string back, and not before `2000-01-01` (a string
comparison: the format is fixed-width). The round trip refuses what a parser would quietly turn into another
day, and what the database would refuse: Bun reads `new Date("2026-02-30")` as 2026-03-02 and `2025-02-29`
as 1 March, and `Date.UTC` reads the years 0–99 as 1900–1999, so `0000-01-01` — which Postgres's `date`
input refuses, a 500 — and `0050-01-01` come back as 1900 and 1950 and are refused. The floor is the
product's bound, not the database's (below): Postgres holds every year from 0100. The ceiling is the
format's own, `9999-12-31`, which Postgres and `Date.UTC` both hold; a read bounds the period as `day >=
from AND day <= to`, never `day < to + 1 day` (for `9999-12-31` that is year 10000, whose ISO form
`+010000-01-01T…` Postgres refuses). Outside the rule — empty, sent twice, `2026-2-01`,
`2026-11-13T00:00:00Z`, `2026-02-30`, `1999-12-31`, `0000-01-01` — the answer is 400 `invalid_request`
naming the field (`day`, `from`, `to`), decided from the string before any `auth`, owner or database call,
nothing written or changed. A `day` inside the rule and after today in `Europe/Zurich` stays 422
`future_day` (AC-1.3); the rule is checked first. The span ("The span", above) and a cursor's day ("The
cursor", below) are measured only between two valid days: a bad `from` or `to` is reported on that field,
never as a span or a cursor error.

*Why 400 for `day`, not a 422 like `future_day`:* the rule depends on the string alone, never on the time
or on stored data — the class of the id rule and the span, both 400 — while the 422s name rules whose answer
depends on today or on the lists (`future_day`, `*_retired`); one schema then serves body and query with one
answer, and no error code is added. *Why 2000-01-01:* the suite records hours from 2026, so a day decades
earlier is a mistyped year (`0226`, `1026`) that would be saved, confirmed and then missing from every
period the person looks at; one floor for `day` and for `from`/`to` keeps every stored entry inside a period
the list accepts; and a floor can be lowered later without touching a stored row, while raising it would
strand rows below it. hours-ui applies the same rule, so the 400 is reached only through a client bug:
`lib/period.ts` `dayOf` already round-trips through `Date.UTC` (T24), and the Day field (`max` today) and
the Custom period refuse a day before `2000-01-01` with a field error (`rangeErrors` gained the floor at T29,
`MIN_DAY`; the dialog's Day field carries `min="2000-01-01"` and checks the floor before the future day,
T27). *Rejected:* `new Date(text)` validity alone (Bun rolls `2026-02-30` over to 2 March, and
that day would be stored); zod's `z.string().date()` alone (it takes `0000-01-01`, the 500 above); the round
trip with no floor, i.e. from `0100-01-01` (keeps mistyped years, and a floor added later would strand
them); a 422 code of its own for a day before the floor (a code no screen shows, since the client refuses
the day first).

**The id rule and a NUL-free note** (amended 2026-11-13; T6, T8, T10; widened the same day to path
and query ids). `Id` — every id hours-api receives: in `POST` and `PATCH` bodies `on.id`,
`on.categoryId`, `workTypeId`, `activityId`; the path `{id}` of `PATCH` / `DELETE /time-entries/{id}`,
`PATCH /time-categories/{id}` and `PATCH /work-types/{id}`; the list and totals filters `userId`,
`projectId`, `dealId`, `meetingId`, `categoryId`, `workTypeId` — is 1..64 characters with no NUL
(`\u0000`), no comma and no whitespace at either end (`id.trim() === id`). The characters of an id are
counted as UTF-16 code units (`id.length`), the unit of every owner's bound (zod `.max(64)`,
meetings-api's `id.length`), so hours-api's bound is exactly theirs; a note and a name count code points
instead (below). `note` refuses a NUL. Outside either rule the answer is 400 `invalid_request`, decided
from the string before any `auth`, owner or database call:
- a body id or `note`: `field` names it (`on.id`, `activityId`, `note`, …); a note's length stays 422
  `note_too_long`;
- a filter: `field` names the filter (`dealId`, `userId`, …); a filter sent empty (`projectId=`) or twice
  is outside the rule too, never "no filter" — hours-ui omits a filter that is not set. *Rejected:* empty
  as absent (activities-api's reading of an empty `companyId`): a client bug would silently widen a
  deal's or a project's figures to the whole period, the failure meetings-api's `ids` refuses (T8);
- a path `{id}`: `field: "id"`, alike for the owner, a holder of `time-entry:read-all` and anyone else.

Each part closes a path to a wrong answer:
- **1..64, no NUL** — the bound every owner puts on an id it receives (projects-api and crm-api
  resolve, activities-api `ids` and `dealId`, meetings-api `ids`; 64 in all four). Sent anyway, the
  owner answers 400 or 422, which hours-api's clients must read as `unavailable` (R7): a 503
  `host_unavailable` for a request that is merely malformed, while AC-2.11's 503 means the owner could
  not answer.
- **No NUL** in an id hours-api looks up in its own tables (`categoryId`, `workTypeId`, a path `{id}`,
  every filter) or in `note`: Postgres `text` cannot hold one, so it would reach the generic 500 (T10).
- **No comma** — a meeting's `on.id` and `activityId` travel inside the comma-separated `ids` of
  meetings-api and activities-api, which split after percent-decoding: `a,,b` holds an empty member
  (422 at both), and `a,b,c,…` with more than 25 members — 64 characters hold up to 32 — exceeds
  meetings-api's cap (422).
- **No whitespace at either end** — meetings-api trims each member, so an id of spaces is an empty
  member (422); and the system route trims `dealId`, so ` d1` would list the meetings of `d1` while
  hours-api's own query looked for ` d1`.
- **The `dealId` filter** is the one filter hours-api forwards: to `GET /system/meetings/hosts?dealId=`,
  which bounds it like an `ids` member (trimmed, 1..64). Outside the rule that route's 422 would be read
  as `unavailable` (R7), so a malformed filter would get the AC-4.11 503 ("Meetings cannot say") instead
  of "your request is malformed". The other five filters reach only hours-api's own query.

Every other character is percent-encoded by the clients (`URLSearchParams`) and reaches the owner as
sent. No owner id or user id falls outside the rule (cuids, UUID v4 for the activities crm-api creates,
better-auth's generated alphanumeric user ids), so the 400 says nothing about whether a record exists. A **well-formed** id keeps its answer: one no owner knows
is the same 404 `not_found` as one the caller cannot read (AC-2.10); an unknown `activityId` is 422
`activity_not_allowed` (AC-2.7), an unknown `categoryId` / `workTypeId` 422 `category_not_found` /
`work_type_not_found`, an unknown path `{id}` the 404 of an entry or a list item that is not there (no
`code`; § Errors, "Two 404 bodies"), and a well-formed filter that matches
nothing an empty answer. *Rejected:* the owners' bound alone (1..64, no NUL) — a comma or a blank
meeting id would still come back as an owner's 422, so as a 503; a character class matching today's ids
(`[A-Za-z0-9_-]`) — it ties hours-api to every owner's id generator, and a new id format would be
refused by hours-api alone.

*A path `{id}` outside the rule: 400, not 404.* No record hours-api holds has an id outside the rule
(entries and list items are cuids, the seeded items `tc-…` / `wt-…`), so the 400 depends on the string
alone, is the same for every caller and every database state, and tells nothing about whether an entry
exists or whose it is — AC-1.6's and AC-2.10's non-disclosure holds as for body ids. It is what T10's
`invalidRequestHook` already answers for a path parameter that fails its schema, so one `Id` schema
serves body, query and path with one answer, as the siblings validate a path id with their `IdParams`
schema (activities-api, projects-api: their validation error, never a 404). On the list routes the live
`time-list:manage` check runs first (route middleware, before validation — the projects-api shape), so
a non-holder is refused 403 whatever the id or the body; on the entry routes only the app-wide
middleware (body limit, session) precedes the shape check. *Rejected:* a 404 identical to a nonexistent id — just as silent, but the check would
leave the shared schema for a branch in each handler, giving one rule two answers depending on where an
id travels, and a handler that forgot the branch would send a NUL to Postgres (the 500 this closes).

**Counting a note and a name** (amended 2026-11-13; T10's CHECK, for T12 and T14). `note` is at most
1000 **Unicode code points**, and a list `name`, trimmed at the ends, 1..80 code points: in code
`[...value].length` (a string iterates by code point), never zod's `.max()` or `.length`, which count
UTF-16 code units. Code points are what the CHECK `time_entry_note_length` counts (`char_length`; T10's
test "counts characters, not bytes") and what OpenAPI's `maxLength` means (JSON Schema counts code
points), so the routes document `maxLength: 1000` / `80` next to a `refine`. Counted with `.max(1000)`,
a note of 501–1000 emoji (two units each) would be 422 `note_too_long` though the database accepts it.
hours-ui's note counter and field error ("n of 1000", `design.md` S2) and admin-ui's name check (≤ 80
after trimming, S5) count the same way, so the browser and the server agree on every input. Ids keep
`id.length` (above): the owners' bound is in UTF-16 units. *Rejected:* UTF-16 units for the note and
names (a limit stated in characters where one emoji counts twice, and a counter that disagrees with what
the person typed); grapheme clusters (`Intl.Segmenter` — the CHECK cannot count them, and 1000
graphemes can hold more than 1000 code points: a 500 at the CHECK); changing the CHECK (the init
migration is written, and migrations are never modified).

**The cursor** (amended a third time 2026-11-13, for T17). `nextCursor` is
`base64url("<day>|<createdAt>|<id>")` of the page's last item: `day` as `YYYY-MM-DD`, `createdAt` as 13
decimal digits of epoch milliseconds, zero-padded (exact: the column is `TIMESTAMP(3)`; an instant before
2001-09-09 has 12 digits, T17; 13 digits span 1970–2286, so no instant Postgres refuses can be written),
`id` the entry's id. The list's order is `day desc, createdAt
desc, id desc` — `id` last, so rows sharing a day and a `createdAt` (a direct insert, two saves in one
millisecond) are still walked exactly once — and the next page starts strictly after the cursor's position
in that order. A `cursor` is accepted only when hours-api could have minted it: at most 200 characters, only
the base64url alphabet (`[A-Za-z0-9_-]`), re-encoding its decoded text gives the same string (the decoder
skips foreign characters and ignores trailing bits, so `YR` decodes like `YQ`), and the decoded text is
exactly three `|`-separated parts — a day under "A day" (above) inside `from..to` (`2026-02-30` is none;
compared only once `from`, `to` and the span hold), 13 digits, and an id inside the id rule. Anything else, a parameter sent
empty or twice included, is 400 `invalid_request` with `field: "cursor"`, decided before any `auth`,
owner or database call, never a 500 (a NUL would reach Postgres `text`, an impossible date its `date` input, junk a
Prisma error). The cursor is not signed and need not be: it only positions a read the caller may make
anyway, under the same `whose`, filters and span, so a forged one reaches no row those would not return.
*Rejected:* the last item's id alone (notify-api's scheme: deleting that entry would break Load more, and
the order is not by id); an ISO instant (year `0000` round-trips in JavaScript and is refused by Postgres —
the 500 this closes); a signed cursor (a secret that protects nothing).

**A lone surrogate in a note or a name** (amended a third time 2026-11-13, for T12 and T14). JSON can carry
half of a surrogate pair (`"\ud800"`); it passes the NUL check and the code-point count, and the Postgres
driver encodes the string as UTF-8 with U+FFFD in its place, so the stored text would silently differ from
what was sent. A `note`, and a list `name` after trimming, must be well-formed UTF-16
(`String.prototype.isWellFormed()`), else 400 `invalid_request` naming the field (`note`, `name`), nothing
written or changed. *Rejected:* accepting it (stored text that is not what the person sent); replacing it
ourselves (the same change, made on purpose). Ids get no such check: no owner and no hours-api table holds
an id with a lone surrogate, so it gets the answer of any well-formed unknown id (404, or 422
`activity_not_allowed` / `category_not_found` / `work_type_not_found`) and is never stored, because an id
is stored only after its owner or hours-api's own table confirmed it (`URLSearchParams` even sends U+FFFD
to an owner in its place, an id nobody holds). Typing does not produce one, so hours-ui and admin-ui carry
no client rule for it; a 400 there is a client bug, shown as the generic error.

**A blank note** (amended a third time 2026-11-13, for T14; spec AC-1.7, AC-3.6, A7). A note is **blank**
when `String.prototype.trim` leaves nothing (`""`, spaces, tabs, line breaks, no-break spaces). A blank note
is no note: stored `null`, returned `note: null` (a view never carries `""`), an empty Note cell in the
export, and it never satisfies `note_required` — AC-3.6's "has no note" is about what the entry says, and
a note of spaces says nothing. Any other note is stored exactly as sent, not trimmed (the person's text,
exported whole, AC-4.6; a name is trimmed because it is a label, AC-3.8). The checks run in this order on
the note as sent: a NUL or a lone surrogate → 400; more than 1000 code points → 422 `note_too_long` (a long
blank note too, so hours-ui's "n of 1000" counter and the server agree); then blank → `null`.
`note_required` (amended a fourth time 2026-11-13: the user's decision D50) is checked when a `POST`
records an entry, and when a `PATCH` sends `note` or moves the entry — sends an `on` other than the stored
target (an `on` equal to it counts as unchanged, as for bookability, D46). When it is checked, it is checked
against the entry **as it will be stored** — its category (sent, else stored) and its note (sent, else
stored) — and refuses 422, nothing changed, when that category requires a note and the note is none:
- `PATCH { note: "" }`, `{ note: "  " }` and `{ note: null }` all clear the note: 200 with `note: null` on
  an entry whose category does not require one (or that is on a project, deal or meeting), 422
  `note_required` on one whose category does — whether or not the entry had a note before;
- a `PATCH` that omits `note` keeps the stored note, so `PATCH { on: { type: "none", categoryId: "tc-other"
  } }` on an entry without a note is 422 unless the same `PATCH` sends a non-blank note;
- a `PATCH` that sends neither `note` nor another target is **not** checked: an entry recorded without a
  note before its category was marked as requiring one (`requiresNote: true` touches no entry, § Lists)
  takes `PATCH { minutes }` or `{ day }` → 200, its note still `null`, and gains a note only when its
  author sends one.

The dialog applies the same rule. Recording, Note is required whenever the chosen category requires one
(`design.md` S2). Editing, a blank Note blocks Save only when the note was changed or the entry is moved to
a category that requires one: an untouched note is not sent (an edit sends only the members that changed,
T28), so it is never checked. hours-ui counts a blank note as none, so the browser and the server agree.

*Rejected:* storing `""` (two values for "no note"); refusing a blank note with 400 (clearing the field
would be an error instead of a clear); trimming every note (changes what the person typed, and the length
would no longer be what the counter shows); checking every `POST` and `PATCH` against the entry as it will
be stored, the reading this plan first wrote (amendment 3) — a minutes-only fix of an entry recorded before
its category required a note would be refused until a note is typed; the user chose D50, the least
invasive option, over it.

**A change and a move** (amended a fifth time 2026-11-13: as T14 built it, `entries.routes.ts`
`validateWrite`; decisions.md § T14). A `PATCH` is validated against the entry **as it will be stored** —
each member the `PATCH` sends, else the stored one — for every rule, as D50 already does for `note_required`
(above). A `PATCH` whose `on` names a target other than the stored one is a **move**.
- **A move carries what the entry has.** The stored `workTypeId` and `activityId` stay on a moved entry unless
  the `PATCH` sends them, and they must fit the new target, else 422 and nothing changes: the work type comes
  from the new target's list — on a meeting or no entity, or from the other list, `work_type_not_allowed`;
  the activity is asked again of activities-api for the new project or deal (step 5 of § Sequences; not one
  of its own, `activity_not_allowed`), and carried onto a meeting or no entity it is `activity_not_allowed`
  with no call. Neither is ever dropped silently. A client that moves an entry therefore sends
  `workTypeId: null` / `activityId: null` for what it cleared — `null`, never an omitted member, which keeps
  the stored one. hours-ui's dialog clears the activity whenever the project or deal changes
  (`hours-ui/src/components/EntryDialog.tsx` `editEntity`), and its edit sends a cleared member as `null`
  (T28).
- **The work type an entry already has is not chosen anew** (AC-3.4: the entries that already have it keep
  it). Re-sent with the target unchanged — a client that sends the whole form back — or carried across a
  move to a target of the same list (project to project, deal to deal), a work type retired since stays:
  200, shown with `retired: true`. A **different** retired work type is chosen, and refused 422
  `work_type_retired`. An entry on no entity has its category as its target: an `on` naming the stored
  category is no move and keeps it, retired or not; an `on` naming another category chooses it (422
  `category_not_found` / `category_retired`).
- A pointer that is neither new nor carried is never asked again (D47): an unchanged `activityId` re-sent with
  the target unchanged is not checked.

*Rejected:* dropping a carried work type or activity that no longer fits (a correction of the target would
silently lose what the person recorded — the loss D47 refuses for a pointer); clearing both on every move
(loses a work type that still fits, project to project); refusing the stored retired work type when re-sent
or carried as if it were chosen (a client that sends the whole form back could not save an entry that AC-3.4
says keeps it). T15 and T16 pinned the carried work type and activity through the owners' checks
(`src/entries/{bookability,deals,activityPointer}.test.ts`), where T14's tests had stopped at its 501
(§ Errors).

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
  months), the list sizes, and the people / projects / deals with entries in it. `totalMinutes` is the
  sum of the tallied groups, never a second aggregate, so both come from one read (T18, `groups.ts` `Tally`).
- **The query** (amended a sixth time 2026-11-13, as T18 built it): the list's filters and rules
  (`filters.ts`), strict — `cursor`, `limit` or any member the route does not name → 400
  `invalid_request`, `field: ""`; `groupBy` required, one of the six, sent once, else 400
  `field: "groupBy"`.
- **Sources asked.** `unavailable` names only the sources this grouping needed, in the order of the
  `Unavailable` type: `day`, `month` and `category` read no other service; `person` reads `identities`;
  `project` reads `projects`; `deal` reads `meeting-deals` and `crm`. A `dealId` filter also asks the
  system route's `?dealId=`, whatever the grouping; its failure is the whole read's 503 (below), never a
  name in `unavailable`.

| `groupBy` | `keyed` groups | `key` | `label` | other kinds | order of `groups` |
|---|---|---|---|---|---|
| `person` | one per person with matching entries | user id (usable as `userId`) | live name from `auth POST /authz/users/identities` (ADR-0039, AC-4.8), `status` likewise; `null` + `status: "unknown"` when not resolved (source `identities`); a deactivated account `null` + `status: "deleted"`, which is no outage and names no source (T18) | — | `label` by `Intl.Collator("en", { sensitivity: "base" })`, `null` labels last, then `key` |
| `project` | one per project the viewer can read | project id | the project's label as the viewer reads it | `hidden`, `unavailable`, `none` (deal, meeting and no-entity entries) | `minutes` desc, then `label` (the same collator, `null` last), then `key`; then `hidden`, `unavailable`, `none` |
| `deal` | one per deal the viewer can read: entries on the deal **plus** entries on meetings currently linked to it (AC-2.6) | deal id | the deal's label as the viewer reads it | `hidden` (also meetings linked to a deal id outside the id rule, § Views), `unavailable` (crm did not answer), `deal-unknown` (meeting entries; `meeting-deals` did not answer), `none` (project and no-entity entries; meetings linked to no deal, linked to a host that is not a CRM deal, or no longer existing) | as `project`; then `hidden`, `unavailable`, `deal-unknown`, `none` |
| `category` | one per category used | category id | the name as typed (AC-3.8), `retired` | `none` (project, deal and meeting entries) | `minutes` desc, then `label` (the same collator), then `key`; then `none` |
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
- `groupBy=deal` with a `dealId` filter asks the system route twice (amended a sixth time 2026-11-13;
  T18, `totals.ts` `byDeal`): `?dealId=` for the filter, `?ids=` for the grouping. The first not
  answering is the 503 above; the second not answering alone puts the matched meeting entries in
  `deal-unknown`, names `meeting-deals` and keeps `totalMinutes` whole. A relink between the two calls
  could count a matched meeting under its new deal — a window of milliseconds, accepted.
- A list item on a meeting: `on.deal = { state: "unknown" }`.

### Errors (entries and totals)

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_request` | schema violation, unknown key, an empty `PATCH` body `{}` (`field: ""`, as for an unknown top-level key: a `PATCH` changes at least one member), bad query (a span over 366 days counting both end days, or `from` after `to` — `field: "to"`; `userId` without `whose=all`, a holder's included — `field: "userId"`; unknown `groupBy`; a query member the route does not name — `field: ""`, `cursor` or `limit` on the totals included; a `limit` that is not 1..500 written plainly — `field: "limit"`); a `day`, `from` or `to` that is not a real calendar day from 2000-01-01 (`field` names it; § Entries, "A day"); a body id, a filter id or a path `{id}` (`field: "id"`) outside the id rule; a NUL or a lone surrogate in `note`; a `cursor` hours-api did not mint (`field: "cursor"`) (§ Entries) |
| 422 | `invalid_minutes` | not 30..1440 in steps of 30 |
| 422 | `future_day` | a real calendar day (§ Entries, "A day") after today in `Europe/Zurich` |
| 422 | `note_too_long` / `note_required` | > 1000 code points (§ Entries, "Counting") / on a `POST`, or a `PATCH` that sends `note` or another target (D50): the category the entry will have requires a note and the note it will have is none — absent, `null` or blank (§ Entries, "A blank note"); a `PATCH` that sends neither is never refused for it |
| 422 | `category_not_found` / `category_retired` | |
| 422 | `work_type_not_allowed` | on a meeting or no entity, or from the other list |
| 422 | `work_type_not_found` / `work_type_retired` | |
| 422 | `activity_not_allowed` | not an activity of the same project/deal, or target is meeting/none |
| 403 | `not_on_project` | project readable, caller not PM or team member |
| 403 | `not_involved_in_deal` | deal readable, caller not owner, technical contact, assignee or participant |
| 403 | `owner_only` | holder of `time-entry:read-all` writing someone else's entry |
| 403 | `read_all_required` | `whose=all` — with or without `userId`, which travels only with it — without the permission (list and totals) |
| 404 | — (no `code`) | `PATCH` / `DELETE`: no entry of the caller's has this id — someone else's (a non-holder, or a holder when `auth` cannot say) or none at all — one identical body (AC-1.6); also a list item no one has (§ Lists). For a well-formed id; one outside the id rule is the 400 |
| 404 | `not_found` | `POST`, or a `PATCH` that moves the entry: the target is missing or not readable, or a meeting the caller is not the creator or a participant of — one identical body naming no kind of target and no id (AC-2.10) |
| 503 | `host_unavailable` | projects-api, crm-api, activities-api or meetings-api did not answer a write's check, or answered with a list that ignored its filter (§ API contracts, "Reading the owners' list answers"); or, on a read with a `dealId` filter (list, totals), meetings-api's `GET /system/meetings/hosts?dealId=` did not answer (AC-4.11, D45). A write's `detail` says nothing was saved; a read's says what could not be said (T19, `src/targets/errors.ts` `hostUnavailable(detail?)`) |
| 503 | `authz_unavailable` | `auth` did not answer an oversight read or a list write |

**Two 404 bodies, one per question** (amended a sixth time 2026-11-13; decisions.md T14, T15, T28). An entry
the caller cannot write answers `{ status: 404, detail }` with **no `code`** (`entries.routes.ts`
`entryNotFound`), and so does a list item no one has (`lists.routes.ts` `itemNotFound`); a target the caller
cannot book on answers 404 with `code: "not_found"` and one detail that names no kind of target and no id
(`src/targets/errors.ts` `targetNotFound`). Each is identical across the cases it covers — someone else's entry
and no entry at all; a missing, an unreadable and a not-yours project, deal or meeting, whatever the kind — so
neither tells anyone what exists. They differ from each other because they answer different questions, and
only the person's own request reaches the second (a `POST`, or a `PATCH` of their own entry that moves it), so
telling them apart says nothing about another person's record. hours-ui relies on it: on an edit, a 404 is the
target's only when the save moved the entry and the answer carries `not_found`, every other 404 says the entry
is gone, and a delete reads any 404 as already gone (`components/EntryDialogModel.ts` `entryIsGone`); admin-ui
reads a list item's 404 by its status (T32). *Rejected:* `code: "not_found"` on the entry's 404 as well, the one
body this table first described — on a save that moved the entry, a vanished entry would read as "that project,
deal or meeting is gone" (T15).

**`field` on a 422** (amended a fifth time 2026-11-13; T14's `rules.ts` `refusal`). Every 422 carries `field`
next to `code`, the member the rule lands on: `invalid_minutes` → `minutes`; `future_day` → `day`;
`note_too_long` and `note_required` → `note`; `category_not_found` / `category_retired` → `on.categoryId`;
`work_type_*` → `workTypeId`; `activity_not_allowed` → `activityId`, whether hours-api decides it alone (a
meeting or no entity) or from activities-api's answer (T16 reuses `rules.ts` `activityNotAllowed()`). A 400
names its member too (T10's hook). hours-ui maps a refusal by `code` (T27 `failureOf`); `field` lets any
other client land it without a table of its own. The detail names the rule, never the value sent. A 403, 404 or
503 carries no `field` (T15, T16): it is about the whole write, not one member.

**Order of the answers** (amended a fifth time 2026-11-13, as T14 built it). A write is answered with the
first failure in this order, and a refused write writes and changes nothing:
1. the session (401) and the app-wide middleware;
2. the shape of the request — body, path `{id}` — 400 `invalid_request` (§ Entries), decided from the request
   alone;
3. `PATCH` and `DELETE` only: the entry is looked up for the caller — the entry's 404 (no `code`, above),
   or for a holder of
   `time-entry:read-all` 403 `owner_only` (T19; § Sequences, "Oversight") — **before any rule**, so a 422
   never answers for someone else's entry;
4. the local rules, 422, in this order: `invalid_minutes`; `future_day`; `note_too_long`; the work type —
   `work_type_not_allowed` when the target takes none (no lookup), `work_type_not_found`,
   `work_type_not_allowed` from the other list, `work_type_retired`; `activity_not_allowed` on a meeting or
   no entity; the category — `category_not_found`, `category_retired`; `note_required`;
5. the owners (§ Sequences): bookability — 404 `not_found`, 403 `not_on_project` / `not_involved_in_deal`,
   503 `host_unavailable` — then the activity pointer — 422 `activity_not_allowed`, 503.

So no owner is called for a write a local rule refuses, and a body that breaks two rules gets the earlier.
*Rejected:* asking the owners before the local rules (an owner call, its latency and its outage for a write
that is refused anyway — a 503 where a fixable 422 was due); the rules before the lookup (a 422 would tell a
caller that an entry exists under an id that is not theirs, AC-1.6).

**501 `not_implemented` is a build-order seam, not part of the contract** (amended a fifth time 2026-11-13;
T14). Until T15 and T16 fill `askOwners` (`entries.routes.ts`), a write that reaches step 5 — a `POST` on a
project, a deal or a meeting, a `PATCH` that moves an entry onto one, a new `activityId` or one carried across
a move — is answered 501 `not_implemented`, nothing written and no owner called: accepting it unchecked would
let anyone book on any project (fail closed, AC-2.11's posture). Entries on no entity and changes that keep
the target and send no new `activityId` answer normally. T15 removed it for projects and meetings, T16 for
deals and the activity pointer. T17 and T18 used the same seam for `whose=all` on the list and the totals —
answered after the 400s and before any `auth`, owner or database call — until T19 put the oversight check there
(amended a sixth time 2026-11-13). Since T19 no route answers 501: `grep -rn not_implemented hours-api/src`
prints nothing, and T20's matrix and contract test assert that no cell answers 501 and that the OpenAPI
documents none (R11). No client handles it (hours-ui shows the generic error).

### Lists

```
GET /time-lists?includeRetired=true|false          // any JWT
  200 { categories: CategoryView[]; workTypes: { project: WorkTypeView[]; deal: WorkTypeView[] } }
  // each list ordered createdAt asc, name asc, id asc (as T12 built it; `name` in the database's
  //   collation): the A15 rows, created together, come out by name and an item added later after them;
  //   with includeRetired=true a retired row keeps its place in that order (admin-ui shows a card's
  //   active rows first, design.md S5)

type CategoryView = { id: string; name: string; requiresNote: boolean; retired: boolean }
type WorkTypeView = { id: string; list: "project" | "deal"; name: string; retired: boolean }

POST  /time-categories       { name: string (1..80, trimmed), requiresNote?: boolean }        → 201 CategoryView
PATCH /time-categories/{id}  { name?: string; requiresNote?: boolean; retired?: boolean }   → 200 CategoryView
POST  /work-types            { list: "project" | "deal", name: string (1..80, trimmed) }      → 201 WorkTypeView
PATCH /work-types/{id}       { name?: string; retired?: boolean }                            → 200 WorkTypeView
  // PATCH: at least one member; strict (any other key, `list` included → 400 invalid_request)
  // name (POST and PATCH): trimmed at the ends, then 1..80 code points with no NUL (`\u0000`) and no
  //   lone surrogate — else 400 invalid_request, `field: "name"`; Postgres text cannot hold a NUL, and
  //   its driver would store U+FFFD for a lone surrogate (T10; amended three times 2026-11-13;
  //   counting and surrogates: § Entries)
  // {id} of PATCH: the id rule (§ Entries), else 400 invalid_request, `field: "id"`; a well-formed
  //   unknown id → 404 with no `code` (§ Errors, "Two 404 bodies"; admin-ui reads the status, T32)
  // time-list:manage, live, checked first (route middleware; only a refusal remembered, 30 s per
  //   (sub, perm_epoch); § Sequences, "Admin lists"): 403 time_list_manage_required,
  //   503 authz_unavailable; 409 name_taken; no DELETE route is mounted (AC-3.2): DELETE on either
  //   path is the app's 404 (`notFound`) whatever the id
```

Retire and restore — the same `PATCH` on both routes:
- `retired: true` sets `retiredAt = now()` (kept when already set): the item leaves
  `GET /time-lists` without `includeRetired`, is refused when chosen for a new entry or in a change
  (`*_retired`), and stays on — and is shown by — the entries that have it, through their later changes
  (AC-3.4; the one an entry already has is never chosen anew: § Entries, "A change and a move").
- `retired: false` **restores** it (AC-3.1 as amended, D38): `retiredAt = null`, offered again in
  `GET /time-lists` and accepted on new and changed entries.
- Both are idempotent (200, row unchanged) and neither touches an entry.
- Changing `requiresNote` touches no entry either: an entry recorded without a note stays without one,
  and is refused `note_required` only when its note is sent or it is moved (D50; § Entries, "A blank
  note").
- Names stay unique: uniqueness (`lower(name)`, per list for work types) already spans retired rows,
  so a restore alone can never collide; a rename in the same `PATCH` is checked like any rename
  (409 `name_taken`, nothing changes — one transaction).

### Export file (hours-ui, built in the browser — AC-4.6, AC-4.10, D39, D40)

`buildHoursWorkbook(items: TimeEntryView[], copy): Workbook` in `hours-ui/src/lib/hoursWorkbook.ts`:
one sheet, one row per item in the list's order, from every page of `GET /time-entries` with the
active filters (`limit=500` until `nextCursor` is `null`; a page that hands back a cursor already followed
stops the walk with the button's failed alert, and there is no page cap, which would shorten the file
silently — T30, `lib/exportPages.ts`). Headers and placeholder words come from the strings catalog in the
viewer's language. The file carries no ids and is named `hours-<from>_<to>.xlsx`, from the period, never from
a person (T30).

| # | Column | Cell |
|---|---|---|
| 1 | Day | a date cell from `day` (`dd.mm.yyyy`) |
| 2 | Person | the screen's name for the person (amended a sixth time 2026-11-13: T29's `personName`, which T30 reuses so the file never disagrees with the table it exports): `person.name`; `null` or blank → the "Unknown user" word; a deactivated account (`status: "deleted"`) adds the "(deactivated)" suffix — "Unknown user (deactivated)", since `auth` names no deleted account |
| 3 | Hours | a **number**, `minutes / 60` (150 → 2.5; always a multiple of 0.5, exact), number format `0.0` — never a "2 h 30" string (D39; AC-4.9 is the screen) |
| 4 | On | the type word: Project / Deal / Meeting / Other work |
| 5 | Name | the project, deal or meeting `label`; `hidden` → "Not visible to you"; `unavailable` → "Name unavailable"; empty for other work |
| 6 | Counts for deal | the deal the hours count for (D40): an entry on a deal → that deal; on a meeting → `on.deal` (`linked` + `visible` → its label, `hidden` → "Not visible to you", `unavailable` → "Name unavailable", `unknown` → "Unknown", `none` → empty); project and other work → empty |
| 7 | Category or work type | the name as typed (AC-3.8) |
| 8 | Activity | `activity.subject`; `hidden` → "Not visible to you"; `unavailable` → "Name unavailable"; none or deleted → empty |
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
GET /activities?ids=a,b,c          // the fifth "exactly one of" filter (companyId, contactId, dealId, projectId, ids)
  // ids: ONE comma-separated parameter, ≤ 50 elements as sent (a duplicate counts toward 50 and
  //   still yields one row); each element exact (never trimmed), 1..64 characters, no NUL
  // 422 naming `field: "ids"`: an empty element (`a,,b`, `a,`, `,a`), an element over 64 characters,
  //   a NUL, the parameter repeated (`ids=a&ids=b`), more than 50 elements
  // `ids=` (empty) counts as absent, as an empty `companyId` always did (alone: the "exactly one" 422)
  // `type` / `open` narrow as on every list; `page` / `pageSize` are ignored
  // only the hosts owning at least one matching row are asked, each as the caller: a lookup of CRM
  //   activities does not depend on projects-api
  200 { items: Activity[]; total; page: 1; pageSize: 50 }   // existing Activity view, newest first
      // ALWAYS ONE PAGE, `total` = the items returned: an omitted id means "does not exist, or the
      // caller may not read it" (one outcome, nothing tells the two apart), never "cut off"
  503 host_unavailable   // a host owning a matching row did not answer — never a shorter list, also
                         // when another host said "not a reader"
  // hours-api never sends it empty (no id, no call) and reads every answer as complete (no paging).
  // Cost (T6): while one host is down, a guessed id it holds answers 503 where an unknown id answers
  // 200 — existence, never content (§ Security).
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
GET /meetings?ids=a,b,c             // selfScoped; narrows the caller's own meetings (creator or Operai participant)
  // ids: ONE comma-separated parameter, ≤ 25 members as sent (a duplicate counts toward 25 and still
  //   yields one row); each member trimmed, then 1..64 characters
  // 422: an empty list (`ids=`, `ids=%20`) or member (`a,,b`, `a,`, `,a`), a member over 64
  //   characters, more than 25 members, the parameter repeated (`ids=a&ids=b`) — never "no filter"
  // a member holding a NUL names no meeting: absent, 200 (never sent to the database)
  // ANDed with every other filter (q, role, status, hostApp); `total` counts the intersection
  200 { items: MeetingRow[]; total; page; pageSize: 25 }   // MeetingRow unchanged (role, title, startsAt, host)
      // newest first; a host-only reader's meeting, someone else's and an unknown id: absent alike (AC-2.10)
      // `page` still applies: 25 ids fit page 1, so hours-api sends no `page` (and never an empty `ids`)

GET /system/meetings/hosts?ids=a,b,c        // each meeting's current host
GET /system/meetings/hosts?dealId=<id>      // the meetings currently linked to that CRM deal
  // as T9 built it (meetings-api/src/system/hosts.routes.ts and its test; amended 2026-11-13)
  // credential, checked BEFORE the query: a service JWT, RS256 via AUTH_JWKS_URL, issuer pinned,
  //   aud = SERVICE_AUDIENCE, scope meetings.hosts.read (alone or among others), sub system:hours-api
  //   only. Every failure — none, a user JWT, another scope / aud / iss / key / sub (another service
  //   client holding the scope included), expired, malformed, a non-Bearer scheme, and ANY token while
  //   meetings-api's SERVICE_AUDIENCE is unset — is the same 401, byte for byte
  // exactly one of ids / dealId, else 422 with `field: "ids"`
  // ids: ONE comma-separated parameter (≤ 6500 characters raw), ≤ 100 members as sent (a duplicate
  //   counts toward 100 and still yields one row); each member trimmed, then 1..64 characters
  //   422: an empty list (`ids=`) or member (`a,,b`, `a,`, `a,%20,b`), a member over 64 characters,
  //   more than 100 members, the parameter repeated; a member holding a NUL names no meeting: absent, 200
  // dealId: one id (≤ 128 characters raw), trimmed, then 1..64 characters; 422: empty, blank, over 64,
  //   repeated; a NUL → { items: [] }, 200. Matches the meetings whose stored host is exactly
  //   { app: "crm", entityType: "deal", entityId: dealId }. NOT paged and NOT capped: every linked
  //   meeting comes back (a capped answer would be AC-4.11's "answered low"; R2)
  200 { items: { id: string; host: { app: string; entityType: string; entityId: string } | null }[] }
  // host: what the meeting stores, three strings (ADR-0059: a host is data, never a branch); today
  //   only crm / deal exists (specs/021 AC-11.1), but the route does not narrow it. null = linked to
  //   none. Independent of the creator's hostVisible choice. Order: id ascending
  // never a title, participant, duration or any content; an id that names no meeting is omitted
  // env: SERVICE_AUDIENCE is OPTIONAL in meetings-api's env.ts (unset → every call the one 401: a
  //   deploy that precedes the variable fails closed instead of stopping the service); env-doctor's
  //   production contract requires it (T33)
  // hours-api sends only ids and a dealId inside its id rule (§ Entries) — 100 ids of 64 characters
  //   and 99 commas = 6499 ≤ 6500, no member to trim, no NUL — so a 4xx here is a version or
  //   configuration gap, read as `unavailable` (R7), never the caller's malformed input. Its client
  //   accepts any `host` strings: a host that is not crm / deal is "no deal" (§ Views), never a failed
  //   batch; from a `dealId` answer it keeps only items whose host is exactly that deal
```

### Reading the owners' list answers (hours-api's clients, amended a third time 2026-11-13)

How `src/clients/` reads a list it asked by id or by deal, as T11 built it (`owner.ts` `keepAsked`,
`activities.ts`, `meetings.ts`; decisions.md T11). T13–T18 code against these outcomes; a client answers
"absent" only for an id the owner actually ruled on.
- **By ids** — activities-api `GET /activities?ids=`, meetings-api `GET /meetings?ids=` and
  `GET /system/meetings/hosts?ids=`: for each asked id the first item carrying it is kept, and an item
  nobody asked for is never believed (an owner cannot inject an entry). When an answer carries such an item
  **and** an asked id is missing from it, the owner did not apply the filter — a meetings-api before T8
  ignores `ids` and answers the caller's latest page (R7) — so the missing id proves nothing: the whole call
  is `unavailable` (`filter_ignored`), never "absent". A write answers 503 `host_unavailable` (AC-2.11),
  never the 404 of a meeting the caller is not on nor the 422 `activity_not_allowed` of an activity that
  does not exist; a read names the source in `unavailable` (`activities`, `meetings`, `meeting-deals`) and
  shows what an unanswered source shows (`visibility: "unavailable"`, `on.deal = { state: "unknown" }`),
  never what absence means (`activity: null`, a meeting `hidden`, `{ state: "none" }`). Foreign items alone,
  with every asked id answered, are dropped and the answer stands.
- **By deal** — `GET /system/meetings/hosts?dealId=`: an item whose `host` is not exactly
  `{ app: "crm", entityType: "deal", entityId: <dealId> }` is dropped — never counted for the deal, never a
  reason to refuse the answer. The route exists only where T9 shipped it (before, a 404: `unavailable`),
  requires exactly one of `ids` / `dealId` and is uncapped, so a foreign item is no sign that a linked
  meeting is missing.
- **The deal scan** — `GET /activities?dealId=` (step 4 of "Record an entry on a deal", AC-2.3): an item
  not about that deal (about another deal, or none), an empty page while the owner's `total` says there is more, or pages that do not add
  up to that `total` make the whole scan `unavailable` (503 on the write): there, absent means "not
  involved" (403), so a scan that cannot account for every activity must not pass for the whole list. The
  10-page bound (R9) is the one accepted shortfall.
- **By host resolve** — projects-api and crm-api `POST /activity-host/v1/resolve` (amended a sixth time
  2026-11-13: T11's `owner.ts`, `projects.ts`, `crm.ts`, as T15 and T16 rely on them): `reader: false` alone
  decides — `not_reader`, the target's 404 on a write and `hidden` on a read. Otherwise every asked id must be
  answered `missing` or `open`, an open item must carry `assignees` (a project) or `involved` (a deal) — absent
  is not "nobody" — and its `href` must be a suite path. An asked id left unanswered, an open item without that
  list, an `href` outside the suite, or one batch that does not answer makes the whole call `unavailable`: 503
  `host_unavailable` on a write, never a 404 or a 403, and `unavailable` on a read.

### auth (changed)

- Catalog `hours`: `time-entry` → `read-all`; `time-list` → `manage`; both
  `supportedConditions: []`, seeded to `admin` only.
- Scope `meetings.hosts.read` in `KNOWN_SERVICE_SCOPES`; client `hours-api` in `SERVICE_CLIENTS`
  with that scope — in production **only after the new auth is live** (ADR-0076: an unknown scope
  stops auth).

## Test strategy

Backends: `bun test` with each service's harness. hours-api gets its own (`test-support/env.ts`,
`testAuth.ts`, `world.ts`, and `hosts.ts` playing projects-api, crm-api, activities-api, meetings-api and
`auth`'s resolve, identities and service-token routes, scriptable per test), against a scratch
`DATABASE_URL` (backend tests truncate dev databases). Frontends: Vitest component tests. E2E: `shell/e2e/hours.spec.ts` through the host. The `@operai/ui` additions carry
their own story and test (`formatMonth` and `short` in `src/lib/i18n-format.test.tsx`, `SearchPicker`
and `ExportButton` in their `*.test.tsx`), referenced by the rows below where an AC rests on them.

| AC | Level | Test |
|---|---|---|
| AC-1.1 | integration + e2e | employee with no tool grant `POST` a `none` entry → 201, listed by `GET whose=mine`; e2e records one from `/hours` |
| AC-1.2 | unit + integration + DB | 0, 15, 45, 1470 → 422 `invalid_minutes`; 30 and 1440 → 201; raw insert breaks `time_entry_minutes` |
| AC-1.3 | unit + integration | `todayIn("Europe/Zurich")` across the UTC midnight boundary; tomorrow and `9999-12-31` → 422 `future_day`; on `POST` and `PATCH`, a `day` that is not a real calendar day from 2000-01-01 — `2026-02-30`, `2025-02-29`, `2026-13-01`, `2026-00-10`, `2026-11-00`, `1999-12-31`, `0000-01-01`, `0050-01-01`, `2026-2-01`, `2026-11-13T00:00:00Z`, `""` — → 400 `invalid_request` with `field: "day"`, nothing written or changed, never a 500 and never a rolled-over day stored; `2000-01-01` and `2024-02-29` → 201 |
| AC-1.4 | integration | 6 h on an internal project + 6 h on a client project the same day → both 201; `groupBy=project` gives 6 h each, `groupBy=day` gives that day 12 h |
| AC-1.5 | integration | owner `PATCH`es and `DELETE`s an entry dated 400 days ago → 200 / 204, only the members sent changed; an empty `PATCH {}` → 400 `invalid_request` with `field: ""`, row unchanged |
| AC-1.6 | integration | another user (admin included) `PATCH`/`DELETE` → 404, byte-identical to a well-formed id no entry has once `instance` — which echoes the requested path — is set aside, and carrying no `code` (§ Errors, "Two 404 bodies"); a read-all holder's write on a nonexistent id, and a holder's write on someone else's entry while `auth` is down → that 404, never `owner_only`; a `PATCH` breaking a rule (`minutes: 15`) on another user's entry → that 404, never the 422 (looked up before any rule); read-all holder → 403 `owner_only`, a rule-breaking body included; `POST` with `userId` → 400; row unchanged; a path `{id}` outside the id rule — 65 characters, `%00`, `a%2Cb`, `%20a`, `a%20` — → 400 `invalid_request` with `field: "id"` on `PATCH` and `DELETE`, alike for the owner, a read-all holder and a third user, no `auth` call recorded, never a 500 |
| AC-1.7 | integration + DB | 1001 characters → 422 `note_too_long`; 1000 → 201; CHECK holds; counted in code points: 1000 emoji (2000 UTF-16 units) → 201 and stored whole on `POST` and `PATCH`, 1001 emoji → 422 `note_too_long`; a note holding `\u0000` → 400 `invalid_request` with `field: "note"` on `POST` and `PATCH`, nothing written or changed, never a 500; a note holding a lone surrogate (`"\ud800"`, `"a\udc00b"`, a high surrogate last) → the same 400, nothing written or changed; `""` and `" \n\t"` → 201 with `note: null` stored and returned; `"  text "` → stored and returned exactly as sent; 1001 spaces → 422 `note_too_long` |
| AC-1.8 | contract | strict schema: `start`/`end` keys → 400; OpenAPI view has no time-of-day member |
| AC-2.1 | unit + integration + DB | every target / category / work-type combination: allowed → 201, others → 400/422; CHECK rejects raw rows; an `on.categoryId` or `workTypeId` holding a NUL or of 65 characters → 400 `invalid_request` naming it, never a 500; every 422 carries `field` next to `code` (§ Errors); a body breaking a local rule is refused before any owner call (the fake records none), and one breaking two gets the earlier in § Errors' order (`minutes: 45` with a retired category → `invalid_minutes`; a meeting `on` with a work type and an activity → `work_type_not_allowed`) |
| AC-2.2 | integration (fake projects) | caller in `assignees` → 201 in every state, `writable:false` ignored; readable but not in `assignees` → 403 `not_on_project`; `reader:false` → 404 |
| AC-2.3 | integration (fake crm + activities) + crm-api integration | involved as owner, technical contact, task assignee, participant → 201; other CRM reader → 403 `not_involved_in_deal`; won and lost deals accepted. crm-api: resolve `deal` returns owner + technical, leaves out an override row's admin, `reader:false` without `crm:access` |
| AC-2.4 | integration | entry created, caller then removed from `assignees`: still listed and counted under the project; `DELETE` → 204 |
| AC-2.5 | integration (fake meetings) + meetings-api integration | creator or participant → 201; host-only reader (absent from `GET /meetings?ids=`) → 404. meetings-api: the `ids` filter returns only the caller's meetings, ANDed with `q` / `role` / `status` / `hostApp` (`total` = the intersection); 25 members → 200, 26 → 422 (26 copies of one id too); an empty list (`ids=`, `ids=%20`) or member, a 65-character member and `ids=a&ids=b` → 422; a NUL member → absent, 200; members trimmed; `pageSize` 25 |
| AC-2.6 | integration + meetings-api integration | meeting entries grouped under deal A and listed with `on.deal = { state: "linked", id: A }`; fake system route relinks to B → totals and the item move to B; a meeting whose stored host is not a CRM deal (`{app: "testhost", entityType: "widget"}`) → `on.deal = { state: "none" }`, no crm-api resolve carries its `entityId`, `meeting-deals` not in `unavailable`, the batch's other meetings keep their deals; a `?dealId=` answer item whose host is not that deal is dropped; a meeting stored with host `crm` / `deal` and an `entityId` outside the id rule (65 characters, a NUL, a comma, a space at either end) → `on.deal = { state: "linked", visibility: "hidden" }` with no `id`, no crm-api resolve carries it, the page's deal entries and other meetings keep their visible labels and `crm` is not in `unavailable` (with crm-api down it stays `hidden` while the others are `unavailable`); an empty `entityId` → `{ state: "none" }`. meetings-api (as T9 built it): `{id, host}` only, `host` as stored (a non-CRM host included; `null` unlinked; whatever `hostVisible`); `?ids=` 100 → 200, 101 → 422, an empty list or member, a blank member, a 65-character member and a repeated parameter → 422, a NUL member absent; `?dealId=` lists exactly the meetings linked to that CRM deal (not another host's entity of the same id) and follows a relink, 130 linked → 130 (unpaged, uncapped), empty / blank / 65 characters / repeated → 422, a NUL → `[]`; neither or both filters → 422 `field: "ids"`; no token, a user JWT, a wrong scope / aud / issuer / key / sub, expired, malformed, and any token while `SERVICE_AUDIENCE` is unset → byte-identical 401, before the query is read |
| AC-2.7 | integration + activities-api integration + component | activity of another project/deal, or a well-formed id activities-api does not return → 422 `activity_not_allowed`; on `meeting`/`none` → 422; a task of the same project → 201; on `POST` and `PATCH`, an `activityId` outside the id rule (empty, 65 characters, a NUL, a comma, a space at either end) → 400 `invalid_request` with `field: "activityId"` and no activities-api call recorded; a `PATCH` moving a project or deal entry to another project or deal the caller may book on carries its stored `activityId` and asks activities-api again for the new target — not one of its own → 422 `activity_not_allowed` with `field: "activityId"`, row unchanged, while the same move with `activityId: null` → 200; carried onto a meeting or no entity → 422 with no activities-api call; an unchanged `activityId` re-sent with the target unchanged → 200 while activities-api is down (never re-asked, D47). activities-api: `ids` filter returns readable activities only, omits missing and unreadable alike; 50 matches → one page `{page: 1, pageSize: 50, total: 50}`, also when `page` / `pageSize` are sent; 51 elements (51 copies of one id too), an empty element, a 65-character element, a NUL and `ids=a&ids=b` → 422 with `field: "ids"`; `ids=` counts as absent; a lookup of CRM ids alone does not ask projects-api; a host owning a matching row down → 503 `host_unavailable` with no `items`, also when the other host says "not a reader". hours-ui: the activity picker loads `GET /activities?projectId=` / `?dealId=` for the picked entity; a 404 or 503 shows its error state and Save stays enabled |
| AC-2.8 | integration | two people, three days, one task → all 201, same `activity.id` in the list |
| AC-2.9 | integration | fake activities-api stops returning the pointed id → entry still listed and counted, `activity: null`, export activity cell empty; owner then changes the note → 200 and the stored `activityId` is unchanged (D47); project hidden from the viewer → activity rendered hidden, not `null` |
| AC-2.12 | integration (fake projects + crm + activities + meetings) | entry on a project, caller then removed from `assignees`: `PATCH {minutes, note, workTypeId, day}` → 200 with **no bookability call**, proved by the save succeeding while projects-api is down (a bookability call would be 503) — never by counting the fake's resolve calls: the view the `PATCH` returns reads its labels as the viewer through the same `POST /activity-host/v1/resolve` (T13), which the fake cannot tell from a bookability call; same with the project answering `reader:false` → 200 (a bookability call would be 404); `PATCH {on: <same project>}` → 200 while projects-api is down; `PATCH {on: <another project the caller is not on>}` → 403 `not_on_project`, row unchanged; `PATCH {activityId: <task of that project>}` with activities-api down → 503; deal (involvement lost; crm-api and activities-api down) and meeting (no longer a participant; meetings-api and its system route down) variants alike |
| AC-2.10 | integration | missing vs unreadable project, deal, meeting → byte-identical 404 bodies with `code: "not_found"`, a well-formed id no owner knows included, one body for a project and a meeting alike (no kind named); for each target type, an `on.id` outside the id rule — empty, 65 characters, a NUL, a comma (`a,,b`), spaces only or at either end — → 400 `invalid_request` with `field: "on.id"` and the fake hosts record no call (never 503, never the owner's 422); a well-formed `on.id` holding `&`, `#`, `+`, `%` or an inner space reaches the fake host exactly as sent and, unknown, is the same 404 |
| AC-2.11 | integration | each source down / timeout / 500 during a write → 503 `host_unavailable`, no row written; likewise an owner answer that ignored its filter — meetings-api `ids` answering the caller's latest page without the asked meeting (the fake's `legacy`), activities-api `ids` answering another activity and not the asked one, a deal scan holding an activity not about that deal or pages that do not add up to `total` — → 503, never 404, 422 `activity_not_allowed` or 403 `not_involved_in_deal` |
| AC-3.1 | integration + component (admin-ui) | holder creates, renames, retires and **restores** a category and a work type in each list; after `PATCH { retired: false }` the item is back in `GET /time-lists` and a new entry with it → 201; retire and restore are idempotent (200, row unchanged); rename-and-restore to a taken name → 409 `name_taken`, row unchanged; a `name` holding `\u0000` or a lone surrogate (`"\udc00"`) → 400 `invalid_request` (`field: "name"`) on create and rename in each list, row unchanged, never a 500; a name of 80 emoji after trimming → 201, 81 → 400 `field: "name"` (code points); `PATCH /time-categories/{id}` and `/work-types/{id}` with an `{id}` outside the id rule (65 characters, `%00`, `a%2Cb`, `%20a`) → 400 `invalid_request`, `field: "id"`, for a holder, never a 500, and 403 for a non-holder whatever the id; `GET /time-lists` returns each list in `createdAt asc, name asc, id asc` order — the A15 rows by name, an item added later after them, a retired row in its place with `includeRetired=true`. admin-ui: an active row offers Rename + Retire, a retired row Rename + Restore, each sending one `PATCH`; the name check counts code points (80 emoji pass, 81 do not) |
| AC-3.2 | integration + DB | `DELETE /time-categories/{id}` and `/work-types/{id}` → 404, row present; raw delete of a used row blocked by `Restrict` |
| AC-3.3 | integration + component (admin-ui) | a caller without `time-list:manage` — including one whose role has Admin access but not the permission — → 403 `time_list_manage_required` on create, rename, retire and restore, row unchanged; `auth` down, slower than 2 s, answering a redirect or a body that is not a permission list → 503 `authz_unavailable`, row unchanged; a refusal is remembered 30 s per `(sub, perm_epoch)` (the same person and epoch refused again with no `auth` call, a new epoch asked afresh) while a grant is asked on every write (a revocation refused on the very next write with the same token) and an outage is remembered as neither; a role holding `time-list:manage` without Admin access → the API accepts (hours-api's gate is the permission alone). admin-ui: no Time lists link and `PermissionDenied` on `/time-lists` without `time-list:manage` |
| AC-3.4 | integration | retired item absent from `GET /time-lists`, present with `includeRetired`; new entry with it → 422 `*_retired`; old entry still shows it, `retired: true`, and its author changes its note, day and duration → 200; a `PATCH` re-sending the stored retired `workTypeId` with the target unchanged → 200, kept; a different retired work type → 422 `work_type_retired`, row unchanged; the stored retired work type carried across a move to another project the caller is on (a deal to another deal they are involved in) → 200, kept; a move to another category that is retired → 422 `category_retired` (§ Entries, "A change and a move") |
| AC-3.5 | integration | project entry with a deal work type → 422; meeting / none with a work type → 422; none without → 201; a `PATCH` moving an entry that has a work type keeps it unless it sends `workTypeId` — to a meeting, to no entity or to the other kind of target → 422 `work_type_not_allowed` with `field: "workTypeId"`, row unchanged, and the same move with `workTypeId: null` → 200 when the new target is bookable; to a bookable target of the same kind → kept |
| AC-3.6 | integration + component | `tc-other` without a note, with `null`, `""` or `"  "` → 422 `note_required`; with a note → 201; `PATCH { note: "" }` and `PATCH { note: null }` → 422 on a `tc-other` entry, row unchanged, and 200 with `note: null` on a Training entry; `PATCH { on: { type: "none", categoryId: "tc-other" } }` on an entry without a note → 422, and 200 when the same `PATCH` sends a note; D50 — an entry recorded without a note on a category then marked as requiring one (`PATCH /time-categories/{id} { requiresNote: true }`): `PATCH { minutes }` and `PATCH { day }` → 200, note still `null`; `PATCH { on: <its own category> }` → 200 (unchanged target, not checked); `PATCH { note: "" }`, `{ note: "  " }` or `{ note: null }` on it → 422 `note_required`, row unchanged; a non-blank note → 200. component (hours-ui): recording, a blank note on a category that requires one shows the required-note error and sends nothing; editing, a minutes-only change of such a note-less entry sends `{ minutes }` and saves, while clearing the note of an entry whose category requires one, or moving a note-less entry to such a category, shows the required-note error and sends nothing |
| AC-3.7 | migration | a fresh test database holds exactly the A15 rows |
| AC-3.8 | component (hours-ui, admin-ui) | a name typed "Formazione" renders verbatim with `lang=en` and `lang=it` |
| AC-4.1 | integration + component + e2e | integration: `groupBy=day` keys `YYYY-MM-DD`, newest first, each the sum of that day's matching entries; the list's cursor walks every matching row exactly once in `day desc, createdAt desc, id desc` — rows inserted with the same day and `createdAt` included — with `limit` 1, 2 and 500. component: My hours shows each day's total from `groupBy=day` — a day whose entries straddle two list pages shows its full total before Load more; no "incomplete" marker in the DOM; no notification call. e2e: two entries on one day → that day's total on `/hours` |
| AC-4.2 | integration | `whose=all`, with or without `userId`, without the permission → 403 `read_all_required` (list, and totals for every `groupBy`), with no system-route call recorded even beside a `dealId` filter; `userId` without `whose=all` → 400 `field: "userId"`, a holder's included, no `auth` call; `whose=mine` never returns another person's row; own versus other (D44, § Views "Ids of what the viewer cannot read"): a `whose=mine` read returns the caller's rows only, so a project, deal, meeting or activity hidden from them or `unavailable` (owner down) keeps its id there; a holder's `whose=all` read keeps `on.id` and `activity.id` on the holder's own rows and answers `null` on another person's rows whose record is not `visible`, while a `visible` record keeps its id on every row |
| AC-4.3 | integration | holder sees entries of `welld_ch` and `welld_it` users |
| AC-4.4 | integration + component | each filter narrows items and totals alike; the period counts both end days, on list and totals: `from = to` (one day), `2026-01-01..2027-01-01` and the leap year `2028-01-01..2028-12-31` (366 days each) → 200, `2026-01-01..2027-01-02` (367) and `from` after `to` → 400 `invalid_request` with `field: "to"`; a `from` or `to` that is not a real calendar day from 2000-01-01 — `2026-02-30`, `1999-12-31`, `0000-01-01`, `2026-2-01`, empty, repeated — → 400 `invalid_request` naming it on list and totals, also beside a valid `cursor` (the period is named, not the cursor), no `auth`, owner or system-route call recorded, never a 500; `2000-01-01..2000-12-31` and `from = to = 9999-12-31` → 200; the person filter's options are the `groupBy=person` groups without `userId`: complete with more people than one list page holds, `key` = user id, `label` = live name, `null` + `identities` in `unavailable` when identities fail; each filter id (`userId` with `whose=all`, `projectId`, `dealId`, `meetingId`, `categoryId`, `workTypeId`) outside the id rule — empty (`projectId=`), 65 characters, `%00`, a comma, a space at either end, repeated — → 400 `invalid_request` naming it on list and totals, no `auth`, owner or system-route call recorded, never a 500; a `cursor` hours-api did not mint — empty, repeated, 201 characters, a character outside base64url, a non-canonical encoding, decoding to junk, to a NUL, to an impossible day (`2026-02-30`), to a day outside `from..to`, to an instant that is not 13 digits or to an id outside the id rule — → 400 `invalid_request` with `field: "cursor"`, never a 500, while the list's own `nextCursor` → 200; a query member the route does not name (`projectID=`, `groupBy` on the list, `cursor` or `limit` on the totals) → 400 `field: ""`. component: `hoursApi` omits a filter that is not set |
| AC-4.11 | integration + component | `dealId` filter with `GET /system/meetings/hosts?dealId=` down / timeout / 500 → list and totals both 503 `host_unavailable`, no `items`/`groups` body; same filter with the route up → 200 including the meeting entries; no `dealId` filter with the route down → 200 (degrades as AC-4.5/4.7); a `dealId` outside the id rule → 400 `invalid_request` with `field: "dealId"` and no `GET /system/meetings/hosts` call recorded — never the 503. component: the filtered view shows its "try again" error state, not an empty or partial list; export with the deal filter fails with the same error |
| AC-4.5 | integration + component | each `groupBy`: `key`, `label` and order as in § Totals; `Σ groups.minutes = totalMinutes` for every `groupBy` over one fixture; meeting entries under their current deal; one `none` group, which also holds a meeting linked to a host that is not a CRM deal; a meeting linked to a CRM deal id outside the id rule counts in `hidden`; two deals the viewer cannot read → one `hidden` group; system route down → meeting entries in `deal-unknown`, `meeting-deals` in `unavailable`, `totalMinutes` unchanged (no `dealId` filter), and the same when only the second of `groupBy=deal`'s two system-route calls under a `dealId` filter fails; a deactivated person → `label: null`, `status: "deleted"`, `identities` not named; equal minutes ordered by the English collator, then the key. component: month groups labelled through `formatMonth` |
| AC-4.6 | unit + component | `buildHoursWorkbook(items)`: rows = items in order; the nine columns of § Export file in order; Hours is a numeric cell `minutes / 60` (30 → 0.5, 150 → 2.5, 1440 → 24) with format `0.0`; Counts for deal holds the deal for a deal entry and for a meeting linked to one; over one fixture, Hours summed by Counts for deal = that fixture's `groupBy=deal` groups (placeholders ↔ `hidden` / `unavailable` / `deal-unknown`, empty ↔ `none`). Person is the screen's `personName` ("Unknown user", "Unknown user (deactivated)"); Activity `unavailable` → "Name unavailable". component: export walks every page with the active filters, and stops with the failed alert on a repeated cursor; a page with `unavailable` → the ready status says names are missing |
| AC-4.7 | integration | each source down → entries still listed and counted, `visibility: "unavailable"`, source in `unavailable`; system route down → meeting entries listed with `on.deal = { state: "unknown" }`, `meeting-deals` named; a by-ids answer that ignored its filter (an item nobody asked for, an asked id missing) → as that source down — `activity.visibility: "unavailable"`, not `activity: null`; the meeting `unavailable`, not `hidden`; `on.deal = { state: "unknown" }`, not `none` — and the source named |
| AC-4.8 | integration | the identities stub renames a person between two calls → the second list and the `person` groups show the new name |
| AC-4.9 | unit (operai-ui) + unit + component | `formatDuration` `short`: 150 min → "2 h 30", 120 → "2 h", 30 → "30 min", both locales; hours-ui rows, day totals and totals render through it; the workbook's Hours cell is a number, never the short string (D39) |
| AC-4.10 | integration + unit + component | holder without `crm:access` lists a deal entry → `visibility: "hidden"`, `label: null`, `activity.subject: null`, minutes counted; a meeting entry linked to a deal the holder cannot read → `on.deal = { state: "linked", visibility: "hidden" }` with no `id`; `groupBy=deal` counts both in the one `hidden` group; the workbook writes the type and "Not visible to you" in Name, Counts for deal and Activity, never a name or an id. Ids (D44; § Views "Ids of what the viewer cannot read"; `src/entries/view.test.ts`, `activityPointer.test.ts`): on another person's entry, a hidden project, deal and meeting → `on.id: null`, and an `unavailable` one (its owner down) → `on.id: null`; its `activity` stays an object, with `id: null`, when the project or deal is hidden or unavailable and when activities-api is down; a `visible` project, deal or meeting keeps its id for others; the author's own hidden or unavailable entry keeps `on.id` and `activity.id` — in `POST` and `PATCH` responses, in `whose=mine`, and when a holder lists their own entry with `whose=all`; `activityPointer.test.ts`'s "still keeps the id" split into own versus other; `TimeEntryViewSchema` and the OpenAPI pin (`openapi.contract.test.ts`) declare both ids nullable. Composition (`src/entries/withheldIds.test.ts`, the review's F1 probe): a holder of `time-entry:read-all` without `crm:access`, who can read none of the records and recorded none of the entries, lists `whose=all` over another person's entry on a hidden deal pointing at one of its activities, another person's entry on a hidden project, and two other people's entries on hidden meetings linked to that deal → `on.id: null` on all four and `activity.id: null`, and the serialized answer, `nextCursor` included, contains none of the hidden deal, project, meeting or activity ids, so hours-api hands out no id to feed a `dealId`, `projectId` or `meetingId` filter. component (hours-ui, T42): fixtures with `null` ids on another person's entries render Everyone's hours and the export unchanged, and `valuesOf` reads a `null` id as nothing to re-pick |
| AC-5.1 | e2e + shell unit | a user with only `employee` opens `/hours` (no access redirect) and records a `none` entry; `tools.test` asserts `/hours` is not a tool |
| AC-5.2 | auth seed contract | catalog `hours` has exactly the two actions with `[]` conditions; admin is the only holder, unconditioned; a role rule `time-entry:read-all` is accepted by `roles.routes` |
| AC-5.3 | matrix | every hours-api route is classified and answers 401 without a credential; `/health`, `/openapi.json` and `/docs` answer anyone, and a CORS preflight answers 204 with no body, `Access-Control-Allow-Origin` only for an allowed origin (T20); no cell answers 501 (R11) |
| AC-5.4 | integration | `auth` down: `whose=all` → 503 `authz_unavailable`; `whose=mine` → 200 |
| AC-5.5 | component | `catalogGaps` parity and `noHardcodedStrings` in hours-ui, admin-ui, shell; the workbook's headers and placeholders come from the catalog |

All 44 ACs of the spec (41 + AC-4.10 + AC-4.11 + AC-2.12) have a row. Re-checked after the 2026-11-12 amendment: the
rows for AC-3.1, 3.3, 4.1, 4.4, 4.5, 4.6, 4.7, 4.9 and 4.10 were rewritten so each fails when the
amended AC is violated (no restore; restore allowed without the permission; a day total from one page;
an incomplete person list; groups that do not sum; a text duration or a missing deal in the file; a
name or an id that leaks). Re-checked after the 2026-11-13 amendment: the rows for AC-1.7, 2.1, 2.5,
2.7, 2.10 and 3.1 gained the id-rule, NUL and owner-filter checks, each failing when a malformed id
reaches an owner (a 503 or the owner's 422 instead of 400), a NUL reaches Postgres (a 500), or an
`ids` answer is cut or paged. Re-checked after the second 2026-11-13 amendment: the rows for AC-1.6,
1.7, 2.6, 3.1, 4.4, 4.5 and 4.11 gained the path and filter ids, code-point counting and the system
route as built, each failing when a malformed path or filter id reaches Postgres (a 500) or the system
route (a 503 instead of a 400), a note or name of emoji is refused below its limit, or a host that is not
a CRM deal is counted as a deal or fails the batch. Re-checked after the third 2026-11-13 amendment: the
rows for AC-1.7, 2.6, 2.11, 3.1, 3.6, 4.1, 4.4, 4.5 and 4.7 gained the cursor, lone-surrogate, blank-note,
stored-deal-id, ignored-filter and inclusive-span checks, each failing when a forged cursor or a lone
surrogate reaches Postgres (a 500, or U+FFFD stored), a note of spaces satisfies `note_required` or is
stored blank, a cursor page repeats or skips a row, one malformed stored deal id makes the page's deals
`unavailable`, an owner that ignored its filter is read as "absent" (a false 404, 422, 403, `activity:
null` or `none`), or a 366-day period counting both end days is refused or a 367-day one accepted. Re-checked after the
fourth 2026-11-13 amendment: the rows for AC-1.3, 3.1, 3.3, 3.6 and 4.4 gained the day rule, the span's
field, the lists' order, refusal-only caching and D50, each failing when an impossible or pre-2000 day is
stored rolled over or reaches Postgres (a 500), `9999-12-31` breaks a read, the span's 400 names `from` or
no field, a revoked holder keeps writing on a remembered grant, or a minutes-only `PATCH` of an entry
recorded before its category required a note is refused (or a blank note sent on such an entry accepted).
Re-checked after the fifth 2026-11-13 amendment: the rows for AC-1.5, 1.6, 2.1, 2.7, 2.12, 3.4 and 3.5
gained the empty `PATCH`, the lookup before the rules, `field` and the order of the 422s, the carried work
type and activity, the kept retired work type and the proof of AC-2.12 by an owner that is down, each failing
when an empty `PATCH` saves, a 422 answers for someone else's entry or follows an owner call, a move silently
drops a work type or an activity (or keeps one that does not fit), an entry cannot be saved with the retired
work type it already has (or takes a different retired one), or a change that keeps the target asks the owner
whether its author may still book. Re-checked after the sixth 2026-11-13 amendment (all 44 ACs still have a row,
compared id by id with spec.md): the rows for AC-1.6, 2.10, 4.2, 4.4, 4.5, 4.6 and 5.3 gained the two 404
bodies, the oversight order, the strict query, the deactivated person, `groupBy=deal`'s second system-route call,
the export's Person and Activity cells and its walk, and the credential-less answers, each failing when the
entry's 404 carries `not_found` (hours-ui would read a vanished entry as a vanished target) or the target's
names its kind, a holder is told `owner_only` about nothing, a non-holder makes hours-api ask meetings-api, a
mistyped query member widens a read, a deactivated person is reported as an outage, a failed second call loses
minutes, the file names a person otherwise than the table, or a credential-less request reaches a handler.
Re-checked after the seventh 2026-11-13 amendment (all 44 ACs still have a row): the rows for AC-4.2 and
AC-4.10 gained the withheld ids, own versus other and the review's composition probe, each failing when the
id of a project, deal, meeting or activity that is not `visible` reaches a viewer who is not the entry's
author — and with it a `dealId`, `projectId` or `meetingId` pivot — or when an author loses an id of their own
entry that the edit dialog needs.

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
  ids, or a server-built export, in that order). `GET /system/meetings/hosts?dealId=` is unpaged and
  uncapped (T9): every meeting linked to the deal, one `{id, host}` row each, which hours-api turns into
  `meetingId IN (…)`. Accepted: meetings are linked to a deal one by one; revisit (a paged route, or
  asking with the period's meeting ids) if one deal passes ~1000 linked meetings. *Early check:* the
  largest number of meetings linked to one deal in meetings-api's database (`count(*)` grouped by
  `hostEntityId` where `hostApp = 'crm'`), read before go-live and when R2's p95 is revisited.
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
  2026-11-13) — and when such an item comes with an asked id missing, the answer is `unavailable`, never
  "absent" (§ API contracts, "Reading the owners' list answers", amended a third time 2026-11-13: an old
  meetings-api's latest page would otherwise turn the creator's own older meeting into a false 404) — so a
  wrong order degrades, never breaks. That reading is right only because hours-api
  never sends an id outside the id rule (§ Entries, amended 2026-11-13): an owner's 4xx is a version
  gap, never the caller's malformed input. The same holds for the `dealId` filter forwarded to the
  system route (amended again 2026-11-13): it passes the id rule first, else 400. And a deal id read
  from the system route passes it before it joins a crm-api batch (§ Views, amended a third time
  2026-11-13): outside the rule it is shown `hidden` and never sent.
- **R9 Deal involvement beyond the scan bound.** The activities scan reads at most 10 pages (1000
  activities) of a deal; a person involved only through an activity past that bound is refused
  `not_involved_in_deal` (accepted 2026-11-13). *Early check:* none needed below 1000 activities per
  deal; revisit with R2's `involvedIn=me` filter. A refusal the bound decides logs one line naming no deal
  and no person (`[bookability] deal activity scan stopped at the 10-page bound (R9) and found nobody`, T16),
  so how often it happens can be counted.
- **R10 Copied modules not drift-checked.** `scripts/check-shared-copies.ts` has no group for estimai-
  api's oversight code or projects-api's authz code, and adding one needs markers inside those apps;
  hours-api registers only in the existing groups (accepted 2026-11-13). *Mitigation:* the copies cite
  their source file in a header comment; a later chore adds the groups.
- **R8 Library components land with one new consumer each.** `SearchPicker` and `ExportButton` are
  shaped by hours-ui while two `CompanyPicker` copies and `ExportYearButton` stay in their apps.
  *Mitigation:* the contracts above cover what the existing copies do (debounce, stale-answer discard,
  status reset); the migrations are listed as follow-up chores in tasks, not done here.
- **R11 The 501 seam outlives its tasks** (amended a fifth time 2026-11-13). T14 answers 501
  `not_implemented` for every write that needs an owner (§ Errors), so that nothing is booked unchecked
  while T15 and T16 are open; left in place, the tool would record hours on no entity only, and a client
  would show a generic error. *Mitigation:* the refusal lives in one function (`askOwners`,
  `entries.routes.ts`) and is pinned by the block marked TRANSITIONAL in `write.test.ts`, which T15 and T16
  replace with their own tests. *Early check:* at T19's close — not T16's (amended a sixth time 2026-11-13:
  T17 and T18 added transitional 501s for `whose=all` on the list and the totals, which T19 replaced) — no
  `not_implemented` remains in `hours-api/src` (`grep -rn not_implemented hours-api/src` prints nothing) and
  no TRANSITIONAL block remains; no cell of T20's matrix answers 501 and the OpenAPI documents none
  (`openapi.contract.test.ts`). Still open: the e2e (T36) records on a project, a deal and a meeting through
  the real owners.

## Security

**Security-sensitive: YES** — schedule the owasp-reviewer in parallel with QE.

- Personal data about workers (what each person worked on, every day) and a read-everyone
  permission; Italian and Swiss rules on monitoring workers (O3, accepted as risk).
- A new resource server with a new authorization path (oversight) and an admin capability, both
  failing closed and neither remembering a grant (a revocation holds on the next request); IDOR surface on `PATCH/DELETE /time-entries/{id}` (scoped to `sub`, identical
  404, given before any 422 rule so a rule never answers for someone else's entry; a path `{id}` outside the id rule is 400 for every caller before any lookup — no stored id falls
  outside the rule, so the 400 tells nothing about a record). The list's `cursor` is not signed: it only positions a read the caller may make anyway, and one hours-api did not mint is a 400 (§ Entries). Restore is a write under the same live `time-list:manage` check as retire.
- A new service client and scope (`meetings.hosts.read`), and meetings-api's first `/system/*`
  route — it must answer only `{id, host}` (ADR-0058: no content to any role).
- What hours-api learns with its **own** credential (a meeting's deal) reaches a viewer only with
  their own right to read that deal: `on.deal` carries an id and a name only when `visible`; totals
  merge what the viewer cannot read; the export carries no ids. A stored host that is not a CRM deal,
  and a stored deal id outside the id rule, is never sent to crm-api and never shown (§ Views). Confirmed by
  the OWASP review on the direct channel (`owasp-report.md` § Answers 1: `labels/resolve.ts` `meetingDealOf`,
  `totals/totals.ts` `placeEntity` and `byDeal`); its one bypass, by composition, was F1 (next bullet).
- **Ids of what the viewer cannot read — D44, decided by the OWASP review 2026-11-13: WITHHOLD** (ledger
  D44, delegated by the user; ADR-0089 A1). `on.id` (project, deal, meeting) and `activity.id` are returned
  only when the record is `visible` to the viewer or the entry is the viewer's own, else `null` (§ Views,
  "Ids of what the viewer cannot read"; T41, T42). *Reason* — finding F1 (Medium, A01; `owasp-report.md`
  § F1): with the ids kept, a holder of `time-entry:read-all` without `crm:access` (a custom controller role,
  R4's audience; the seeded admin has CRM access) read a hidden deal's id and two hidden meetings' ids from
  `GET /time-entries?whose=all`, fed the deal's id back as `dealId`, and got exactly the entries on those
  two meetings: which hidden meetings are linked to which hidden deal, the disclosure ADR-0089 A1 forbids,
  reached through ids instead of names; `projectId` and `meetingId` gave per-record totals that
  `groupBy=project|deal` merges into one `hidden` group by design. Withholding the ids closes the three
  pivots at once, at no product cost. *Rejected:* keeping the ids and asking crm-api as the viewer on every
  `dealId` filter (a new call and a new refusal, and the `projectId` / `meetingId` pivots stay open); `null`
  for the author too (breaks the edit dialog for no gain). *Residual:* an author keeps the ids of their own
  entries, so an author who also holds `time-entry:read-all` can use their own entry's target id as a filter
  over everyone's entries — F2's case below (an id the viewer already knows), not F1's (an id hours-api hands
  to someone who cannot read the record); the other people's rows it returns carry no id of a record hidden
  from the viewer. *Verdict:* the review stays REVIEW REQUIRED (`verdicts.security: "FAIL"`) until T41 is
  built and the review's probe re-run (its step 1 must show `on.id: null` on the hidden deal entry and on
  both meeting entries, and no pivot possible); PASS then, unless the re-check finds something new at
  medium or above.
- Cross-service bookability checks run as the caller and fail closed; labels follow the viewer's
  own access (AC-4.10). hours-ui's pickers call projects-api, crm-api, meetings-api and
  activities-api from the browser as the person, on existing routes — no new origin, no CORS change.
- activities-api `ids` asks only the hosts that own a matching row (T6, § API contracts): while one
  host is down, a guessed id it holds answers 503 where an unknown id answers 200 — existence, never
  content, to someone who guesses a cuid or UUID during an outage. **Accepted by the review** (I2): it
  needs a 41-bit-plus (cuid) or 122-bit (UUID v4) guess and an outage, and the host call an owned id
  triggers already shows in the response time without an outage. *Rejected:* asking every host (a CRM
  lookup would then fail while projects-api is down).
- The person filter reuses the totals route behind `time-entry:read-all`; the user directory's
  audience is not widened (ADR-0066).
- A `dealId` filter on the list or the totals counts the meeting entries linked to that deal, so a
  person who knows the id of a deal they cannot read learns which of their own meetings with hours in the
  period are linked to it — a holder, which of everyone's — never the deal's name (T17, T18 notes for T37). D45 and AC-2.6
  prescribe the filter; it sits beside § Views' rule that `on.deal` withholds a hidden deal's id. **Accepted
  by the review** (F2, Low): the id must already be known — after D44 hours-api no longer hands one out for
  a deal the viewer cannot read, except on the viewer's own entries (above); for `whose=mine`, meetings-api's
  own list already shows a current creator or participant the deal id of the meeting's host
  (`meetings-api/src/meetings/rows.ts`), so the only new case is an author who has since left the meeting;
  and the fact carries no name or content. *Rejected:* requiring the viewer to read the deal (one crm-api
  resolve before the system route) — a new dependency and a new refusal on top of D45's 503, for a marginal
  gain; the review lists it as optional hardening, not taken here.
- Without a credential every route answers 401 (default deny, `src/index.ts`) except `/health`,
  `/openapi.json` and `/docs`, a CORS preflight (204, no body, `Access-Control-Allow-Origin` only for an
  allowed origin) and a body over 64 KiB (413, refused before the session is read) — pinned by T20's
  matrix, the 413 by `src/lib/app.test.ts`.
- The export file is built in the browser from data the viewer can already read; no server file.
- **The review's other findings, accepted** (T37, 2026-11-13, `owasp-report.md`: 0 critical, 0 high, one
  medium — F1, above — and six low; none is a task of this spec):
  - F3 (A09): oversight reads leave no record of who read — accepted by ADR-0088; the one line the review
    suggests when `holdsReadAll` grants (`[oversight] read-all granted sub=<sub> path=<path>`, no query, no
    body) belongs with O3's go-live sign-off.
  - F4 (A04): no rate limit or quota in hours-api, the suite's posture (only `auth` limits); a per-`sub`
    limiter on `POST` is the next step if R2's 800 ms p95 slips.
  - F5 (A04): "involved in a deal" is self-attestable — any `crm:access` holder may write activities on any
    deal and any employee may create a meeting — as AC-2.3 defines it; specs/030 and specs/031 must not build
    billing or approval rules on it.
  - F6 (A03): hours-ui's `suitePath` (`src/lib/names.ts`) is weaker than the server's `isSuitePath`;
    unreachable today (the server refuses whitespace and control characters, and the meeting `href` is built
    with `encodeURIComponent`); defence in depth is to reuse the server's pattern.
  - F7 (A06): hours-api's `bun audit` matches its Bun siblings' (all but `zod` transitive through the
    dev-time Prisma CLI; no request schema takes a user-sized array) and hours-ui's `pnpm audit` is cleaner
    than inventory-ui's; not exploitable here; the osv-scanner gate stays the enforcement point.
  - Notes, no action: I1, the oversight and `time-list:manage` checks count any grant of the pair and ignore
    `conditions`, safe while the catalog declares none (hardening: count only a grant without conditions);
    I2, above; I3, `on.deal` `linked`/`hidden` versus `none` tells a holder that a meeting is linked to some
    deal they cannot read, which the `hidden` / `none` totals need, with no id or name; I4, `NODE_ENV`
    defaults to `development` (a 500 then carries `err.message`), while the production template, the
    Dockerfile and compose set `production` and env-doctor lists it; I5, the CORS preflight answers 204 without
    a credential, `Access-Control-Allow-Origin` only for an allowed origin, pinned by T20's matrix.

Surfaces to review: every hours-api route (`src/entries/`, `src/totals/`, `src/lists/`,
`src/oversight/`, `src/labels/`, `src/targets/`), crm-api resolve `deal`, activities-api `ids`, meetings-api `ids` and
`GET /system/meetings/hosts`, the `hours-api` service client, hours-ui's export. Reviewed 2026-11-13 (T37,
`owasp-report.md` § Surface coverage): every surface passes except F1, which T41 closes and T37 re-checks.

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
  any later consumer of hours totals. A1 also records D44 (decided 2026-11-13 by the OWASP review: an
  entry's `on.id` / `activity.id` only when the record is `visible` or the entry is the viewer's own;
  rejected: a viewer crm read on every `dealId` filter, and `null` for the author too) — already written in
  the ADR (§ A1, "Decided 2026-11-13 (D44): WITHHOLD"); no new ADR.
- **ADR-0090** (`docs/adr/0090-hours-ui-ungated-remote.md`) — Hours get their own remote, mounted
  ungated at `/hours` and absent from `TOOLS` (the ADR-0009/0045 shape without a gated half).
  Rejected: an ungated entry in projects-ui (wrong domain; PR #9 rewrites projects-ui), a
  shell-native screen (ADR-0009: no tool logic in the shell), a `TOOLS` entry behind `hours:access`.
