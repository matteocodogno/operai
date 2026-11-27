---
spec: 20261126
status: approved
approved: 2026-11-26
---

# Plan: Teams — named groups of people, managed in Admin, taking part in projects

Planned against `main` at ad7a0719 (2026-11-26). Line references are to that commit.

## Amendments

- **2026-11-26 — two contract changes, decided by the user** on the drift the designer found
  (`design.md` § Gaps and drift, G1 and G2). The plan stays approved; `spec.md` is unchanged (the
  ACs and their count, 30, are the same).
  1. **The name clash carries the existing name (D14).** auth's 409 `team_name_taken`, from
     `POST /admin/teams` and `PATCH /admin/teams/{id}`, now has a required extension member
     `existingName`: the clashing team's name as stored. Reason: the server's `detail` is English,
     so without a structured field admin-ui could not say the AC-1.2 message ("naming the clash")
     in Italian (AC-3.3). Changed: § Data model (auth), § API contracts (auth admin routes, *The
     name clash body*), § UI surface, § Test strategy (AC-1.2, AC-3.3).
  2. **The attach picker searches on the server (D13).** `GET /attachable-teams` takes an optional
     `q` (trimmed, at most 80 characters, case-insensitive name match). The answer is capped at 50,
     with the exact match ranked first, so every active team can be reached by typing its name
     (AC-4.1). Before, the browser filtered a list capped at 500 that could not reach the rest.
     auth's options mode of `GET /system/teams` takes the same `q`. To keep the narrow channel's
     rate property (a decision must not be starved by a caller-driven read), the options mode
     gets its own allowance, `teamsOptions`, and projects-api limits the route per caller. Changed:
     § Architecture (components, read modes, D11, D12, D13, trade-offs), § API contracts, § UI
     surface, § Test strategy (AC-1.5, AC-1.6, AC-4.1, further tests), § Risks (R10, R11),
     § Security (surfaces 2 and 4), § Delivery, § Decisions, § ADR candidates (A1).
- **2026-11-26 — the project page's fresh team read is limited per person (D15), for AC-5.6.** The
  spec gained AC-5.6, re-approved by the user on 2026-11-26 (31 ACs), to close R11. The page's fresh
  ids read sat on the same `teams` allowance (3 000 per 10 min) that hours bookability, task
  assignment and meeting reading depend on, so one person reloading project pages could make those
  decisions unavailable for everyone. projects-api now admits a person's fresh team read only within
  **120 per verified `sub` per 10 min**, and all people's together within **2 400 per 10 min**. That
  keeps 600 of auth's allowance for the decisions' cached path, which is never limited per person.
  When a read is not admitted, the view reads nothing and serves no cached entry, and the page still
  loads. It shows the AC-5.4 markers plus a new `teamsStatus`: `"rate_limited"` with
  `teamsRetryAfterSeconds` when the person's own limit refused it, `"unavailable"` when the service's
  did. `PUT /projects/{id}/teams` now reads its whole new set in one call. When it adds a team and
  is not admitted, it refuses with 429 `rate_limited` or 503 `teams_unavailable`. The plan stays
  approved and the frontmatter is unchanged. The owner confirms D15's figures at the plan gate.
  `spec.md`, `design.md` and the ADRs are not edited here. Changed: § Architecture (components,
  read modes, D3, D11, new D15, trade-offs), § API contracts (view fields, *The project view's team
  read*, `PUT /projects/{id}/teams`), § UI surface, § Test strategy (31 ACs, AC-5.4, AC-5.6, further
  tests), § Risks (R2, R11 closed, R12), § Security (surfaces 4 and 5), § Delivery, § Decisions,
  § Spec amendment (marked accepted), § ADR candidates (A1), § Self-critique.
- **2026-11-27 — the attached team id CHECK drops its NUL clause (drift found in T11).** The plan's
  `position(chr(0) in "teamId") = 0` does not run in Postgres (`chr(0)` raises "null character not
  permitted"), and it is redundant since a `text` value cannot hold a NUL. The implemented
  `attached_team_id_shape` is `char_length("teamId") BETWEEN 1 AND 64` only
  (`projects-api/prisma/migrations/20261126120000_attached_team/migration.sql`, `decisions.md` § T11).
  The plan stays approved; no AC, contract or task changes. Changed: § Data model (projects-api).
- **2026-11-27 — ids and team text refuse a NUL with 400 (QE D1).** The plan said the
  attach-search `q` refuses a NUL "as `IdSchema`", but projects-api's shared `IdSchema`
  (`src/lib/http.ts:123`, `z.string().min(1).max(64)`) did not refuse one, and neither did auth's
  admin team routes. A NUL then reached Postgres, which cannot hold U+0000 in `text` (Prisma
  P2039), and the route answered 500 (`qe-report.md` § D1: seven placements new in this feature,
  plus the pre-existing `projectManagerId` filter). The rule is now stated once, in *No NUL in ids and team text* under § API
  contracts: every projects-api id validated by `IdSchema`, and auth's team `name`, `description`,
  `{id}` and `{userId}` path parameters and body `userId`, refuse a value containing U+0000 with
  400 `validation_failed`, before any database read, with no echo of the value. Through the shared
  `IdSchema` this also covers routes outside the feature (the pre-existing
  `GET /projects?projectManagerId=`); no accepted value changes, only a 500 becomes a 400. The
  plan stays approved; no AC changes and `spec.md`, `design.md` and `tasks.md` are not edited.
  Changed: § API contracts (the new rule, the auth admin route refusals, `PUT /projects/{id}/teams`
  refusals, the `q` step of `GET /attachable-teams`), § Test strategy (further tests).
  Refined in the D1 fix (`projects-api/src/projects/nul.test.ts`, `auth/src/teams/admin.nul.test.ts`): "no echo" means the value never appears in `detail`, `errors` or `field`; `instance` is the request path, as in every Problem of both services, so a path-id value appears there, and that shape is unchanged.
- **2026-11-27 — the host path waits for a team read inside its callers' deadline (D16, eval fix
  round 2).** The eval (`eval-report.md` § Code quality) found that the cached team read ran on a
  5 s budget (`TEAMS_TIMEOUT_MS`, `projects-api/src/lib/teams.ts:49`) inside the activity-host and
  meeting-host resolves, whose callers give up at 2 s (activities-api `RESOLVE_TIMEOUT_MS`,
  `src/hosts/client.ts:31`; meetings-api `RESOLVE_TIMEOUT_MS`, `src/hosts/client.ts:40`; hours-api
  `OWNER_TIMEOUT_MS`, `src/clients/owner.ts:31`). With auth slow rather than down, the caller timed
  out first and activities-api marked the whole batch of 25 projects unavailable, projects without a
  team included: the very outcome D3 exists to avoid, and a break of the suite rule "each inner
  deadline fits inside the outer minus a margin" (ADR 20261119-on-demand-outbound-work-…), with no
  test relating the constants. Now a `cached()` call **waits** at most `TEAMS_HOST_WAIT_MS` = 800 ms,
  counted once from its start, and `TEAMS_HOST_WAIT_MS + TEAMS_HOST_MARGIN_MS` (1 000 ms) stays strictly under
  each of the three 2 s deadlines, asserted by a cross-package test that reads the consumers' constants
  as text (the accounting precedent, `accounting-api/src/budgets.cross-package.test.ts`). A flight still
  running at the wait is a failed refresh **for that call** (an entry of at most 60 s, else unavailable,
  for projects with attached teams only), and it is **not aborted**: it keeps its own 5 s and its answer
  fills the cache for the next call. The page path (`fresh()`, `options()`) keeps 5 s: its outer party is
  the browser, which sets no deadline. Cache semantics (30 s fresh, 60 s usable, 15 s piggyback,
  send-stamped) and the AC-4.6 proof are unchanged; no AC, contract, status code or call count changes.
  The plan stays approved; the owner confirms D16's figures. `spec.md`, `design.md`, `tasks.md` and the
  ADRs are not edited here; the one-line amendment of ADR 20261126-a-host-says-unknown-… (its Risks
  bullet "A team read that is slow rather than failed", which now reads false) is drafted for the
  `adr-writer` under § ADR candidates, A2. Changed: § Architecture (components, D2, new D16, D3,
  trade-offs), § Test strategy (AC-4.6, AC-5.4, further tests), § Risks (R2, new R13), § Delivery,
  § Decisions, § ADR candidates (A2), § Self-critique.

## Architecture

### Shape in one paragraph

A **team** is owned by **auth**: it is an Admin object next to departments, behind the same
`requireAdmin` gate (O2, `auth/src/auth/auth.middleware.ts:79-108`,
`auth/src/admin/departments.routes.ts:462-468`). It lives in two new tables, `team` and
`team_member`, that the permission resolver never reads, so a team grants nothing (AC-2.5).
**projects-api** keeps only *which* teams are on a project: a new table,
`project_attached_team (projectId, teamId)`, with no copy of a name or a member (AC-1.3, O6). It
reads names, members, and each member's Projects access **live from auth over one new narrow
service read**, `GET /system/teams`. That read uses scope `teams:read` and accepts only the `sub`
`system:projects-api`. Auth itself computes each member's `appAccess` for the app the calling
service is bound to. One pure function in projects-api, `onProject()`, then computes the
glossary's **on the project** set: the project manager, the listed members, and the active
attached-team members who hold Projects access. Every place that asks "who is on this project"
uses it: the project view, the activity-host `assignees` (and through it hours-api and
activities-api), and the meeting-host `hostVisible`. The consumers do not change their question.
They get a wider answer, and one new answer: "could not find out". **admin-ui** gets a Teams
section. **projects-ui** gets a Teams half on the Team card, a dialog to attach teams, and a team
filter on the list. Its two hand-copied versions of the rule now read the server's `onProject`
set.

### Components touched / added

| Component | Step | Change |
|---|---|---|
| `auth` — `prisma/migrations/20261126100000_teams` | 1 | `team`, `team_member` (+ case-insensitive unique name index, CHECKs) |
| `auth` — `src/teams/admin.routes.ts` (new) | 1 | `/admin/teams*`: list, create, detail, edit, archive, restore, add/remove member, DELETE → 405; the 409 `team_name_taken` carries `existingName` (D14) |
| `auth` — `src/teams/repo.ts` (new) | 1 | the reads both routers share (detail, active-member counts) |
| `auth` — `src/index.ts` | 1, 2 | mount the admin router (1), the system router (2) |
| `admin-ui` — `TeamsPage`, `TeamDetail`, `TeamFormDialog`, `lib/adminApi.ts`, `strings/teams.ts`, `strings/nav.ts`, `strings/audit.ts`, `router.tsx`, `AdminShell.tsx`, `SectionNav.tsx` | 1 | Teams section; `teams` joins `ADMIN_SEGMENTS` (`AdminShell.tsx:85`) |
| `auth` — `src/teams/system.routes.ts` (new) | 2 | `GET /system/teams` (service JWT, `teams:read`, `sub` → app binding): ids mode, and options mode with an optional `q` (D13) |
| `auth` — `src/authz/resolver.ts` | 2 | `holdersOfAppAccess(appId, userIds)`: the batched form of the predicate app-access-check uses |
| `auth` — `src/system/serviceClients.ts`, `src/system/systemRateLimits.ts` | 2 | scope `teams:read` in `KNOWN_SERVICE_SCOPES`; `DOCUMENTED_CLIENT_SCOPES["projects-api"]` gains it; two allowances, `teams` (ids mode) and `teamsOptions` (options mode) (D11) |
| `projects-api` — `prisma/migrations/20261126120000_attached_team` | 2 | `project_attached_team` |
| `projects-api` — `src/lib/teams.ts` (new) | 2 | the auth client and its send-stamped cache; the cached path waits at most `TEAMS_HOST_WAIT_MS` (800 ms) and lets a slower flight finish into the cache (D16) |
| `meetings-api` — `src/hosts/client.ts` | 2 | `RESOLVE_TIMEOUT_MS` becomes `export const` (no behaviour change) so the D16 cross-package test can read it |
| `projects-api` — `src/projects/onProject.ts` (new) | 2 | the one "on the project" rule (pure) |
| `projects-api` — `src/projects/teams.routes.ts` (new) | 2 | `PUT /projects/{id}/teams` (one fresh read of the whole new set, D15), `GET /attachable-teams[?q=]`, `GET /attached-teams` |
| `projects-api` — `src/lib/rateLimiter.ts` (new) | 2 | an in-process sliding window, copied (no shared package exists) from `auth/src/lib/rateLimiter.ts`: an injectable clock, and `consume` records only admitted attempts. It gains a read-only `peek`. Three module-scope instances: `GET /attachable-teams` per caller (D13), and the fresh team read per person and for the whole service (D15), with `admitTeamRead(sub)` consulting both |
| `projects-api` — `projects.routes.ts`, `projects.schemas.ts`, `activity-host.routes.ts`, `meeting-host.routes.ts`, `matrix.test.ts` | 2 | the view gains `teams`, `onProject`, `onProjectComplete`, `teamsStatus` and `teamsRetryAfterSeconds`, and its fresh team read goes through `admitTeamRead` (D15); the list gains `?teamId=`; the hosts use `onProject()` and never consult the D15 windows |
| `activities-api` — `src/hosts/client.ts`, `src/hosts/registry.ts` (type), `src/activities/activities.routes.ts` | 2 | accept `assignees: null` from a listing host as "unavailable"; refuse an assignment on it with 503 `host_unavailable` |
| `hours-api` — `src/clients/projects.ts`, `src/targets/bookability.ts` | 2 | the same: `null` is "unavailable", and a booking on it is 503 `host_unavailable` |
| `projects-ui` — `TeamCard.tsx` (+ `TeamsDialog`), `TaskFormDialog.tsx`, `TasksCard.tsx`, `lib/recordHours.ts`, `ProjectsPage.tsx`, `lib/projectsApi.ts`, `lib/types.ts`, strings | 2 | Teams on the card; assignees and the Record hours offer from `onProject`; the team filter |
| `tools/env-doctor` — `manifest.ts`, `templates/production/auth.env`, `check.test.ts`; `auth/.env.example`; `infra/README.md` | 2 | `teams:read` in projects-api's scope set; runbook step |
| `shell/e2e` — `admin-teams.spec.ts`, `projects-teams.spec.ts`, `helpers/teamsFixtures.ts` | 1, 2 | journeys |

The groma.md map (`groma/`) is absent from this repository, so no component ids are cited.

### Where teams live, and why auth

- **Auth, not projects-api.** Admins manage teams in Admin with Admin's gate (O2). Admin's API is
  auth's `/admin/*`. A team is a grouping of auth users, like a department, and the user rows it
  points at (with `deletedAt`, AC-2.3) are auth's. A team is also meant to outlive Projects as its
  only consumer ("the model must leave room" for team permissions, Non-goals). If a team lived in
  projects-api, Admin would have to call a tool's API, and a future team permission would sit in
  the wrong service.
- **Not a department.** A department confers roles (`resolver.ts:186-200` reads
  `department_role`). A team must not (O1, AC-2.5), so it gets its own tables, and the resolver is
  never taught to read them. A test pins that (Test strategy, AC-2.5).

### How projects-api reads a team: one narrow service read (decision D1)

The consumers that need team members are usually called **as an ordinary user**. activities-api
and hours-api forward the caller's JWT to `POST /activity-host/v1/resolve`, and meetings-api
forwards it to `/meeting-host/v1/resolve`. A user-JWT route in auth (`/authz/teams/...`) fails
for the people this feature is for, in three ways:

1. auth's user routes limit **per caller** (identities 120 / 10 min, app-access-check 40 / 10 min,
   `auth/src/lib/env.ts:81,100`). One member's hours entry would spend their own budget on every
   team of the project.
2. The per-member Projects-access check (O7, AC-4.7) exists only as `POST /authz/app-access-check`:
   one id per call, 40 per 10 min per caller (`appAccessCheck.routes.ts:197-238`). Ten teams of 100
   members cannot be checked that way on every resolve.
3. A user route would need a caller gate that names a Projects permission inside auth. That is the
   directory-gate shape that ADR 20261104-user-directory-gate-meetings-access warns widens with
   every default grant.

So projects-api asks **as itself**. This is the "narrow, purpose-scoped channel" of ADR
20261103-projects-api-reads-crm-companies-with-scoped-service-credential and ADR
20261104-projects-handoff-live-reads-…, here with auth as the owner, as in
`GET /system/legal-entities` (ADR 20261117-the-letterhead-service-reads-the-issuers-details-itself-…):

- `GET /system/teams` in auth is verified in process exactly like `system.routes.ts` of legal
  entities: RS256, issuer, `aud = SERVICE_AUDIENCE` (a user JWT fails), `sub` `system:<client>`,
  scope `teams:read`, one frozen 401 for every failure. It then checks the `sub` against a code
  binding `TEAM_READERS = { "system:projects-api": "projects" }`. A client that holds the scope but
  is absent from the binding gets the same 401.
- **The app whose access is computed is derived from the verified `sub`, never sent by the caller**
  (ADR 20261119-on-demand-outbound-work-…, "derived by the provider, never claimed by the caller").
  The answer's `appAccess` means "holds `(projects, access)`". No caller can ask about another app.
- auth computes `appAccess` with **one batched query** (`holdersOfAppAccess`). It is the same
  predicate as app-access-check's `permissions.some(p => p.resource === appId && p.action ===
  "access")` (`appAccessCheck.routes.ts:296-301`): any rule on a role held directly or through a
  department, whatever its conditions. A contract test runs the batched form and
  `resolveEffectivePermissions` over the same fixtures and requires equal answers, so the two
  cannot drift.
- Scope naming follows ADR 20261117-legal-entity-registry-…: a suite resource hosted by auth has no
  service prefix and uses the colon form, so the scope is `teams:read`.

The projects-api token provider already exists (`projects-api/src/lib/serviceToken.ts:119-125`).
It is built whenever the CRM group is set, which production requires. No new environment variable
is needed. Locally, a setup without the group gets `teams_unavailable` (fail closed).

**Rejected:**
- forwarding the user JWT to a new `/authz/teams` route (the three failures above);
- calling app-access-check once per member (budget);
- `GET /authz/users/directory?appId=projects` (its gate includes `meetings:access`, so every
  employee can use it, and it lists everyone at 60 / 10 min per caller);
- snapshotting members into projects-api when a team is attached (O6 asks for live);
- having auth push membership changes to projects-api (a replicated copy that must survive loss
  and reordering, ADR 20261104-meeting-host-contract-…; nothing here needs push).

### Freshness and failure: the consumer cache (decision D2)

The cache rule is ADR 20261117-the-letterhead-service-reads-the-issuers-details-itself-…'s
consumer rule. crm-api implements it in `crm-api/src/lib/legalEntities.ts:1-35`. Here it is per
team:

- Each team's entry is stamped with the monotonic time its **request was sent**.
- An entry younger than **30 s** is used without a call.
- Otherwise it is refreshed: single flight per id, 5 s in all for the flight (`TEAMS_TIMEOUT_MS`),
  `redirect: "error"`, a body of at most 1 MiB, ids in chunks of 50. A caller of the cached read waits
  for the flight at most 800 ms (`TEAMS_HOST_WAIT_MS`, D16); the flight itself runs on. A refresh also carries every other cached id whose entry is
  older than 15 s, so entries expire together and the steady state is about one call every 30 s.
- If the refresh fails and the entry is at most **60 s** old, the entry is used and
  `teams_stale_used` is logged.
- If the refresh fails and the entry is older than 60 s, or there is no entry, the answer is
  **unavailable**. It is never "nobody" and never "the listed members only".
- A 401 drops the cached service token and retries once. This covers the first minutes after the
  scope is granted, while the cached token still lacks it.

**Proof of AC-4.6.** A decision at time t uses an entry sent at s ≥ t − 60 s. auth reads its tables
after it receives the request, so a membership change committed at T < t − 60 s < s is in that
answer. hours-api, activities-api and meetings-api keep no copy of a host answer (activities-api
`hosts/client.ts` "never cached"; meetings-api `hosts/client.ts:136-141`; hours-api
`clients/projects.ts`). So 60 s is the end-to-end bound.

**Three read modes, by path** (a read degrades, a write that must confirm refuses; ADR 20261103):

| Path | Mode | On failure |
|---|---|---|
| activity-host / meeting-host resolve, `GET /attached-teams` | cached (above); waits at most 800 ms (D16) | a refresh not answered within the wait counts as failed for this call; then unavailable: see "Unknown is not nobody" |
| the Project view (`GET /projects/{id}` and every write response) | **fresh** for its own ≤ 10 teams, in one call, only when admitted by the per-person and service windows (D15); the answer also refreshes the cache entries | falls back to a cache entry ≤ 60 s old, else `members: null` (`teamsStatus: "unavailable"`). Not admitted: no call, no cache entry served or refreshed, every team marked (`"rate_limited"` or `"unavailable"`, D15) |
| `PUT /projects/{id}/teams` | fresh, never cached: one call for the whole new set, which judges the added ids and builds the answer; admitted by the D15 windows | with an added id: 503 `teams_unavailable`, nothing written; not admitted, 429 `rate_limited` (the person's window) or 503 `teams_unavailable` (the service's), nothing written. With no added id the write goes on and answers the degraded view |
| `GET /attachable-teams` (with or without `q`) | fresh, never cached; its own per-caller limit (D13), on the `teamsOptions` allowance | 503 `teams_unavailable` |

The project view reads **fresh** because AC-1.3 says the *next load* of the page shows a rename.
With a 30 s cache it would not. A fresh read also lets the page's `onProject` set (used to offer
assignees and Record hours) refresh the entries the hosts then use. The offer and the decision then
agree, apart from the short window between two calls. The fresh read is the one read on the
`teams` allowance whose volume a person drives, so it is limited per person and in total (D15).
The cached path that the decisions use is never limited per person.

### Deadlines: the host path waits inside its callers' deadline (decision D16, 2026-11-27)

The cached read runs inside two host routes whose callers stop waiting at 2 s. The page path runs
under no deadline. ADR 20261119-on-demand-outbound-work-… gives the rule: each inner deadline fits
inside the outer one minus a margin, and a test relates the two constants. Its mirror is that an
inner budget so small that normal work always fails is just as wrong.

| Path | Outer party and its deadline | What projects-api spends on the team read |
|---|---|---|
| `POST /activity-host/v1/resolve` | activities-api `RESOLVE_TIMEOUT_MS` = 2 000 ms (`src/hosts/client.ts:31`); hours-api `OWNER_TIMEOUT_MS` = 2 000 ms (`src/clients/owner.ts:31`) | waits ≤ `TEAMS_HOST_WAIT_MS` = **800 ms** |
| `POST /meeting-host/v1/resolve` | meetings-api `RESOLVE_TIMEOUT_MS` = 2 000 ms (`src/hosts/client.ts:40`) | waits ≤ 800 ms |
| `GET /attached-teams` (the list filter's labels, fail soft) | the browser: none | waits ≤ 800 ms, because it is the same `cached()` call (one rule for the cached path, not a knob per route) |
| `GET /projects/{id}`, write responses, `PUT /projects/{id}/teams` (`fresh()`), `GET /attachable-teams` (`options()`) | the browser: none (shell `apiFetch` sets no timeout) | ≤ `TEAMS_TIMEOUT_MS` = **5 000 ms**, unchanged |

**The constants** live in `projects-api/src/lib/teams.ts`, exported and named so a test can relate
them:

- `TEAMS_TIMEOUT_MS = 5_000` (unchanged): the limit of one read, covering the token, the call and the
  one 401 retry. It bounds a flight, `fresh()` and `options()`.
- `TEAMS_HOST_WAIT_MS = 800` (new): the longest one `cached()` call waits for all the flights it needs
  together. It is counted once from the start of the call, not per chunk or per id.
- `TEAMS_HOST_MARGIN_MS = 1_000` (new): the room the resolve keeps under its callers' deadline for
  everything except the team read: JWT verification, a permission check (cached 30 s per
  `(sub, perm_epoch)`), the project query, building an answer of up to R3's size, the two in-region
  hops and event-loop delay. It is 1 000 ms because the accounting precedent's `MARGIN_MS` is
  1 000 ms (`accounting-api/src/budgets.cross-package.test.ts`).
- Invariants, asserted by tests: `TEAMS_HOST_WAIT_MS + TEAMS_HOST_MARGIN_MS < D` for each consumer
  deadline `D` (1 800 < 2 000), and `TEAMS_HOST_WAIT_MS < TEAMS_TIMEOUT_MS` (the flight outlives the
  wait, so a slow answer still reaches the cache).

**What the wait does.** `cached()` starts or joins its flights exactly as before. It then waits for
them, against one timer of `TEAMS_HOST_WAIT_MS`.

- A flight that settles in time settles as today.
- A flight still running when the timer fires is a **failed refresh for this call**, with reason
  `wait_exceeded`. Its ids then follow the D2 rule unchanged: an entry of at most 60 s is used (and
  `teams_stale_used` is logged); otherwise the id is unavailable (and `teams_unavailable` is logged).
- The flight is **not aborted**. It runs to its own `TEAMS_TIMEOUT_MS`, and an answer that arrives
  stores its entries stamped with its own send time, as today. A later `cached()` call inside the
  30 s fresh window finds them without a call. A call that starts while the flight still runs joins
  it (single flight) and gets a full wait of its own.
- When every flight settles before the timer, the call returns at once and clears the timer.
- A call with nothing to refresh starts no timer.
- The wait adds no call to auth and spends nothing more of the `teams` allowance: the flights are
  the ones D2 already makes. No call is aborted and repeated.

**What a slow auth then yields** (slow means it answers in 0.8–5 s; slower than 5 s, or failing, is
D2's failure case as before):

- **activity-host resolve:** it answers within about 0.8 s plus the route's own work, so inside
  2 s.
  - A project with no attached team needs no team read and answers normally (unchanged: "a project
    with no attached team never waits on auth").
  - A project with attached teams gets its `assignees` from entries at most 60 s old, else `null`
    for that item only (D3).
  - The batch is never lost because of the team read.
- **meeting-host resolve:** a caller who is the PM or a listed member is answered without a team
  read. Otherwise the caller is answered from entries at most 60 s old, else with 503
  `teams_unavailable` inside the deadline. meetings-api then reports `hostReadersUnavailable`
  instead of timing out.
- **`GET /attached-teams`:** a team with no usable entry has `name: null`, as for any failed read.
  The next load names it.
- **Steady state:** while auth stays slow but answering, the flights keep refreshing the entries in
  the background, and the decisions answer from entries at most 60 s old. A decision is unavailable
  only for a team with no usable entry. That happens on the first read after a start, or when nobody
  has read the team for over 60 s. The flight that decision started fills the cache, so a retry a
  moment later succeeds. That is what the 503 `host_unavailable` already tells the person ("try again
  shortly").

**Why 800 ms, not about 1.5 s.** The first resolve of a person usually meets a cold permission
cache, so a slow auth is paid twice: once by `/authz/resolve`, then by the team read. If auth takes
X for each, the batch survives while X + min(X, wait) + overhead < 2 s. With an 800 ms wait that
holds up to X ≈ 1.1 s; with 1.5 s, only up to X ≈ 0.95 s, and the warm-path margin shrinks to
0.5 s. A short wait costs little, because the flight runs on. And 800 ms is far above normal work:
auth's ids read is a few indexed queries (the team, its members, the batched `holdersOfAppAccess`),
answered in tens of milliseconds.

**Rejected:**

- **One 800 ms timeout for the whole reader, aborting the flight.** While auth answered in 0.8–5 s,
  every refresh would be cut off and no entry would ever be renewed. After 60 s every project with a
  team would be unavailable while auth is up and answering: the "working provider judged dead"
  failure the ADR names.
- **Raising the consumers' 2 s.** That is three services and a suite-wide host contract, and every
  page that resolves would wait longer for one host's field.
- **A deadline sent by the caller (a header), or a wait counted from the request's arrival.** A
  deadline sent by the caller is a caller claim that sizes the provider's work, which ADR 20261119's
  second half forbids. Counting from the arrival needs a request-start hook on two routes, and it
  only helps a cold permission check against the same slow auth, which no team wait can save.
- **A per-call wait parameter on `cached()`.** It is a second knob a future host route could set
  wrong. The page path that needs longer already has `fresh()`.

**Not fixed here, named (R13).** First, the cold permission resolve: projects-api's
`/authz/resolve` client has a 5 s timeout (`src/authz/resolveClient.ts:20`). On a cache miss against
a slow auth, it can by itself outlast the 2 s callers before the team read starts. That is
pre-existing for every host route, the same class as the auth outage D3 names. Second, the chain
hours-api → activities-api `GET /activities?ids=` → projects-api resolve: activities-api's inner 2 s
equals hours-api's outer 2 s. That is pre-existing, and the team wait fits inside both.

### Unknown is not nobody (decision D3)

AC-5.4 says a decision must never be "answered from the individual members alone".

- **activity-host resolve**: for a project that has attached teams whose members are unavailable,
  the item says `assignees: null`. That means "could not find out". It does not 503 the whole batch
  of up to 25 projects: tasks are listed and opened on that answer (My tasks reads many projects at
  once), and only *assigning* needs the list. activities-api refuses an assignment on `null` with
  503 `host_unavailable`. hours-api refuses a booking on `null` with 503 `host_unavailable`. A
  project with no attached team never waits on auth.
  - Older consumers already fail closed on `null`. activities-api's schema
    `assignees: z.array(nonEmpty).optional()` (`hosts/client.ts:65`) and hours-api's `z.array(...)`
    (`clients/projects.ts:44`) reject it as malformed, which is unavailable. The deploy order is
    therefore safe either way (Delivery).
- **meeting-host resolve**: `hostVisible` absent already means "not granted" in meetings-api
  (`hosts/client.ts:121-123`), so "unknown" cannot be said in an item. When the caller is neither
  the project manager nor a listed member, the project has teams, and their members are
  unavailable, the whole resolve answers **503 `teams_unavailable`**. meetings-api then reports
  `hostReadersUnavailable` and still lists the caller's own meetings
  (`meetings-api/src/hosts/hosts.routes.ts:127-131`). A caller who is the PM or a listed member is
  answered without a team read.
- **Project view**: `members: null` per team, `onProjectComplete: false` and `teamsStatus:
  "unavailable"`. The page loads (AC-5.4, second half). A person over their page limit gets the same
  markers on every team, with `teamsStatus: "rate_limited"` (AC-5.6, D15).

An auth **outage** already makes every projects-api route 503 `authz_unavailable` beyond its 30 s
permission cache (`auth/authz.middleware.ts`). The new failure modes are therefore the narrower
ones: the `teams` allowance spent, a slow or timed-out answer of this route, or a missing scope
grant. D15 keeps page reads from spending the allowance. D16 keeps a slow answer on the host path
inside the callers' 2 s, so it degrades per item and is never lost with the batch.

### The rule, once (decision D4)

`projects-api/src/projects/onProject.ts` exports two pure functions:

```ts
countedMembers(team: TeamFact): string[]            // active && appAccess (AC-4.4, AC-4.7); archived teams count (O4)
onProject(row: { projectManagerId: string | null; memberIds: string[]; attachedTeamIds: string[] },
          teams: Map<string, TeamFact> | "unavailable"): string[] | "unavailable"
  // PM, then listed members (join order), then counted members of each attached team (attach order,
  // then member name order), each id once (AC-4.4, AC-4.5). "unavailable" only when a team is
  // attached and its members are unknown.
```

`activity-host` puts `onProject(...)` in `assignees`. `meeting-host` sets
`hostVisible = onProject(...).includes(caller)`, after a short-circuit for the PM and listed
members. The view builds `onProject: Person[]` from the same call. projects-ui's
`TaskFormDialog.assignable` (`TaskFormDialog.tsx:62-65`) and `recordHours.mayRecordOnProject`
(`lib/recordHours.ts:30-31`) are copies of the old rule today. They change to read
`project.onProject` instead of recomputing it, so the browser keeps no copy of the rule.

### Other decisions

- **D5 — Stale-form refusal in auth uses a body `baseVersion`, not `If-Match`.** auth's CORS
  allows only `Content-Type` and `Authorization` and exposes only `Retry-After`
  (`auth/src/index.ts:49-56`), so `If-Match` from admin-ui would fail the preflight and `ETag`
  could not be read. The legal-entity registry already uses `{ baseVersion }` + 409
  `version_conflict` + `currentVersion` (`auth/src/legalEntities/write.routes.ts:94-169`). The team
  row carries an integer `version`, returned in every body. Rejected: widening auth's CORS for one
  feature, and ETag/If-Match on a service whose admin clients cannot read it.
- **D6 — The version covers the team's own fields (name, description, state), not its members.**
  Membership changes are set operations (add one, remove one) that commute. Putting them under the
  version would make two admins adding different people conflict for nothing. AC-1.8 is about "a
  stale form". Adding an existing member, or removing an absent one, is a no-op with no audit row.
- **D7 — Membership limit under a row lock.** Adding a member runs `SELECT … FROM team WHERE id =
  $1 FOR UPDATE`, counts every row (deactivated members included: they are members, AC-2.3, and
  the limit exists to bound consumers' lookups, O9), then inserts. Two concurrent adds at 99 cannot
  make 101.
- **D8 — No delete.** `DELETE /admin/teams/{id}` answers 405 `not_deletable` with `Allow: GET,
  PATCH` (the ADR 20261103-projects-tool-shape-and-authorization posture for records that are never
  deleted). `team_member.teamId` is `ON DELETE RESTRICT`. No database trigger is added: a team is
  not a financial or governance record (ADR 20260804-two-tier-audit-assurance-…), and tests and e2e
  fixtures must be able to clean up.
- **D9 — Names fail soft, like company names.** Projects keep no copy of a team name (AC-1.3). When
  the name cannot be read, the view says `name: null`, like a company `name: null` when the CRM
  cannot answer (ADR 20261103-projects-api-reads-crm-companies-…). See *Spec amendment proposed*.
- **D10 — Team member names come from the team read, not from `/authz/users/identities`.** With 10
  teams × 100 members, a project page would otherwise spend up to 10 of the viewer's 120 identity
  calls. The system read already holds `user.name`. A deactivated member gets `name: null`, the rule
  `resolveIdentities` applies (`projects-api/src/lib/identities.ts:66-71`, ADR
  20260807-live-identity-resolution-by-id-fail-soft).
- **D11 — Two allowances at auth, per calling service per 10 min, by mode** (amended
  2026-11-26). Both are fixed constants like `LEGAL_ENTITIES_SERVICE_LIMIT`, counted after
  verification (ADR 20261112-system-endpoints-limited-per-verified-service):
  - **`teams`, 3 000** (`TEAMS_SERVICE_LIMIT`), for the ids mode: the members and access bits that
    decisions and the project view read. The cached host path is about 20 calls per 10 min, and
    every project page view and project write costs one fresh call. At wellD's size (tens of
    people) that is in the hundreds per 10 min, so 3 000 leaves ten times the headroom.
  - **`teamsOptions`, 1 500** (`TEAMS_OPTIONS_SERVICE_LIMIT`), for the options mode, with or without
    `q`: only the attach picker reads it. Each settled search text costs one call (the picker
    waits 250 ms after typing stops, and nothing is fetched when the dialog opens), so an attach
    session costs a handful.

  The attach search is driven by what a person types. On a single allowance, that volume could
  spend the budget that decisions depend on. Hence the split: a spent `teamsOptions` makes the
  picker say "could not be searched" and changes no decision. projects-api's per-caller limit on
  `GET /attachable-teams` (D13) keeps one manager from spending `teamsOptions` for the others.
  When `teams` is spent, the page fails soft and the decisions use the cache or say unavailable.
  The fresh page read is driven by people too. projects-api bounds it per person (120) and in total
  (2 400) per 10 min (D15, amended 2026-11-26 for AC-5.6). Page reads can therefore spend at most
  2 400 of the 3 000, and the cached decision path keeps the rest. An ids call costs three indexed
  queries over at most 50 teams and 5 000 member rows. An options call is one query over the active
  teams.
- **D12 — The admin list is filtered in the browser.** `GET /admin/teams` returns every team (name
  order, active and archived), like `GET /admin/departments`. admin-ui applies the state toggle and
  the case-insensitive substring search (AC-1.4). That is fine at wellD's size and avoids `LIKE`
  wildcard questions. A paginated, server-searched list is the trigger if teams pass ~500. The
  attach picker in Projects searches on the server instead (D13). Its answer comes over the capped
  service channel, and a capped list filtered in the browser cannot reach every team. The admin
  list is admin-only and uncapped, so it has no such gap.
- **D13 — The attach picker searches on the server, capped at 50, exact match first** (added
  2026-11-26, decided by the user). `GET /attachable-teams?q=` passes the trimmed text to auth's
  options mode. auth matches with `strpos(lower("name"), lower($q)) > 0`, a parameterised raw
  query. That is the same `lower()` as the unique name index, and it is not `LIKE`/`ILIKE`, so
  `%`, `_` and `\` are literal characters and nothing needs escaping. auth ranks the result:
  1. the name equal to `q`, ignoring case;
  2. names that start with `q`;
  3. the rest.

  Within each group the order is name, then id. At most 50 items are returned, with `truncated`
  when more matched. **Why every team is reachable (AC-4.1):** names are unique under `lower()` (the
  index), so typing a team's whole name ranks exactly that team first, whatever the cap and however
  many other names contain the text. Without `q`, the first 50 active teams come back in name order.
  The cap is 50, not 500, because the list is now a search answer: 50 leaves at least 40 usable
  items after the client drops up to 10 already-attached ids (design G2 (c)). The server does not
  take the attached ids, which keeps the channel at one shape.
  - **Per-caller limit in projects-api:** 120 requests per caller (`sub`) per 10 min, in process
    (`ATTACHABLE_TEAMS_CALLER_LIMIT`, the suite's sliding-window shape, `src/lib/rateLimiter.ts`). It counts every request
    that passed the guard, before `q` is validated, and refuses with 429 `rate_limited`,
    `Retry-After` = the window, and no auth call. A person searching normally stays far below it.
    Like every limiter in the suite it is per replica.
  - **Rejected:**
    - a larger cap with browser filtering, which leaves a dead end past the cap;
    - projects-api fetching every active team and filtering, which is an unbounded answer over the
      service channel;
    - `LIKE`/`ILIKE` with escaping, which is a second case-folding beside the index's `lower()` (R7)
      plus an escaping rule to get right;
    - letting the client pass `limit` or the attached ids, which is more shapes on a narrow channel;
    - prefix-only matching, because the spec's admin search is a substring search and the two
      searches should behave alike.
- **D14 — The name clash names the existing team in a structured field** (added 2026-11-26,
  decided by the user). auth's 409 `team_name_taken` carries `existingName`, the clashing team's
  name as stored (*The name clash body*, below). admin-ui composes the message from it in English
  or Italian (AC-1.2, AC-3.3). The English `detail` stays, for logs and API readers, and is never
  shown. **Rejected:** a localized `detail` (the server would need the reader's language, which
  the suite decides in the browser: `<html lang>`), and a name-less localized sentence (AC-1.2
  asks for a message naming the clash).
- **D15 — The project page's fresh team read is limited per person, and in total, in projects-api**
  (added 2026-11-26 for AC-5.6; the figures are for the owner to confirm). Of the reads on the
  `teams` allowance, the view's fresh ids read (D2) is the one whose volume a person drives. The
  decisions' path is cached and bounded by time: at most one call per 15–30 s per 50 attached
  teams, so about 40 per 10 min. The attach search has its own allowance (D11, D13). Two in-process
  sliding windows of 10 min, auth's window, admit the fresh read:
  - **Per person: 120 per verified `sub`** (`TEAM_READ_PERSON_LIMIT`). Why 120:
    - A project page view already spends one of the viewer's own 120 identity lookups per 10 min
      at auth (`loadPeople` → `POST /authz/users/identities` with the viewer's JWT,
      `IDENTITIES_RATE_LIMIT` 120, `auth/src/lib/env.ts:100`). Below 120 views a person meets no
      new limit. Above it, the page's people names already fail soft.
    - It is 12 project pages a minute for ten minutes, several times a heavy session. projects-ui
      loads the project once when the page opens, gets it back from each project write, and loads
      it again only after a terms or purchase-order write (`ProjectDetailPage.tsx:93,140`). Nothing
      else refetches it, and no other tool reads the view.
    - It is the attach search's figure (D13), on a different budget, so the suite has one figure
      for "a person's reads of one kind per 10 min".
    - It is 4 % of the allowance, so one person can never spend it (AC-5.6: no other person and no
      decision is affected).
  - **For the service: 2 400** (`TEAM_READ_SERVICE_LIMIT`), all people's admitted reads together.
    It reserves 600 of auth's 3 000 for the cached path, which needs about 40 per 10 min per 50
    attached teams. The decisions are therefore never starved by page reads, even if a projects-ui
    bug made every browser reload in a loop. One person (120) never reaches it: it takes 20 people
    at their own limit.
  - **What counts.** A request counts when it would make a fresh ids call for a person:
    - `GET /projects/{id}`, and every route that answers with a `Project`: create, PATCH, the
      transitions, `PUT …/team`, `PUT …/teams` and the take;
    - only when the project has at least one attached team (no team, no call, nothing counted).

    Each such request makes at most one call, because `PUT …/teams` reads its whole new set once
    (*API contracts*). The check runs in `toProjectView`, which now takes the verified `sub` from the
    guards' context, or in the PUT before its transaction. It
    comes after the route's guards (`authorized`, so `projects:access`; for a write also its
    capability, scope, `If-Match` and commit) and after the row is found, so a 403, a 404, a 409
    or a 428 counts nothing. It runs synchronously, right before the auth call.
  - **Only an admitted read is recorded, in both windows at once.** `admitTeamRead(sub)` peeks at
    both windows and consumes both only when both have room, with no `await` in between, so the
    check is atomic in the one event loop. A refused load makes no call and is not recorded. A
    person who keeps reloading is back under the limit as soon as their oldest admitted read leaves
    the window, which is at most 10 min after their 120th. Trying again never extends it (auth's
    `consume` semantics, `auth/src/system/systemRateLimits.ts`).
  - **Not admitted, the page still loads** (AC-5.6: a 200, not a 429 of the page). Every attached
    team is `{ id, name: null, archived: null, members: null }`. `onProject` is the project manager
    and the listed members, and `onProjectComplete` is `false`. `teamsStatus` is `"rate_limited"`,
    with `teamsRetryAfterSeconds` for the person's own window. When the service window refused,
    `teamsStatus` is `"unavailable"` instead: that is the AC-5.4 state, and the person did nothing
    wrong, so they are not told they did. See *The project view's team read*.
  - **No cache for a reader who was not admitted.** The view neither falls back to a cached entry
    nor refreshes one. AC-5.6 asks for the markers, and AC-1.3 holds because the next admitted load
    reads fresh. Serving the cache would hide the limit and make the page inconsistent: names on
    one load, markers on the next.
  - **Never on a decision.** The activity-host and meeting-host resolves (hours, task assignment,
    meeting reading) and `GET /attached-teams` use the cached mode. They never consult these
    windows. **Proof of AC-5.6's last sentence:** in any 10 min, projects-api makes at most 2 400
    page reads plus the cached path's ≤ 600. auth's `teams` allowance (3 000) is therefore not
    reached, and no decision is answered "unavailable" because of anyone's page reads.
  - **A write that must confirm refuses.** `PUT /projects/{id}/teams` that adds a team and is not
    admitted writes nothing:
    - 429 `rate_limited` when the person's window refused, with `retryAfterSeconds` in the body,
      because projects-api's CORS exposes only `ETag` (`src/index.ts:37`) and the browser cannot
      read `Retry-After`;
    - 503 `teams_unavailable` when the service's window refused.

    Every other write commits and answers with the view that was not admitted. That includes a
    `PUT …/teams` that only removes.
  - **Log.** A person's first refusal in a window writes one line,
    `[teams] page-read limited actor=<sub> window=<person|service>`. It holds the actor id, as the
    purchase-order lines do, and no project, team or name. Later refusals in the window write
    nothing.
  - **Per process**, like every limiter in the suite. projects-api runs one replica
    (`.railway/railway.ts`). A second replica would double both figures and use up the reserve (R12).
  - **Rejected:**
    - a 429 for the whole `GET /projects/{id}`: AC-5.6 says the page still loads, and the rest of it
      needs no team read;
    - serving the cache to a reader over the limit (above);
    - recording refused loads: a person who keeps reloading would never get back under, and a
      refused load spends nothing;
    - a short per-person reuse of the fresh answer: it does not bound a person moving between
      projects, and the next load must show a rename (AC-1.3);
    - a per-project limit: moving between projects evades it;
    - a limit at auth per end user: auth sees only `system:projects-api`, so projects-api would
      have to claim who asked, which ADR 20261119-on-demand-outbound-work-… rules out;
    - the person window alone, without the service window: it meets AC-5.6 for one person, but many
      looping browsers could still spend the decisions' allowance.

### Existing ADRs this plan builds on

- 20260713-authz-hand-rolled-rbac-abac-epoch-claims (a team is not part of the resolver)
- 20260716-refund-api-authorization-enforcing-resource-server (fail closed)
- 20260807-live-identity-resolution-by-id-fail-soft (D10)
- 20261006-scoped-service-jwt-fourth-notify-caller and 20261013 (service credentials)
- 20261103-projects-tool-shape-and-authorization (`project:manage` + `If-Match` on every project
  write; 403 `out_of_scope`)
- 20261103-projects-api-reads-crm-companies-… and 20261104-projects-handoff-live-reads-… (D1)
- 20261104-meetings-tool-shape-visibility-by-participation (visibility by relationship: a team is a
  relationship the host states, unchanged in meetings-api)
- 20261110-activities-service-access-delegated-to-host (amended by D3, see ADR candidates)
- 20261112-time-bookability-asked-of-owners-… (hours-api asks the owner; the owner's answer widens)
- 20261112-system-endpoints-limited-per-verified-service (D11)
- 20261117-the-letterhead-service-reads-the-issuers-details-itself-… (D2 cache rule)
- 20261117-legal-entity-registry-… (scope naming)
- 20261119-on-demand-outbound-work-… (the app is derived from the `sub`)

New: `docs/adr/20261126-teams-live-in-auth-grant-nothing-and-their-members-and-app-access-are-read-from-auth-by-the-consumer-as-itself.md`
(A1) and `docs/adr/20261126-a-host-says-unknown-for-the-one-field-a-decision-needs-instead-of-failing-the-reads-that-do-not-need-it.md`
(A2). See ADR candidates.

### Trade-offs: chosen vs rejected

| Chosen | Rejected | Why |
|---|---|---|
| Teams in auth, admin-gated (O2) | teams in projects-api; a department flag | Admin's API is auth; departments confer roles |
| projects-api reads as itself, `teams:read`, `sub` → app binding | forwarded user JWT; per-member app-access-check; the directory | per-caller limits, one id per call, gate width (D1) |
| auth computes `appAccess` in one batched query, proven equal to the resolver predicate | per-user `resolveEffectivePermissions` in a loop | 5 000 resolver calls per answer; the contract test keeps one meaning |
| Live with a 30/60 s send-stamped cache; the page reads fresh | snapshot at attach; no cache; a 60 s TTL everywhere | O6; auth budget; AC-1.3's "next load" |
| `assignees: null` for "unknown" (activity host) | 503 for the whole batch | one project's team read must not hide 24 other projects' tasks |
| 503 for meeting-host when unknown | `hostVisible: false` | false is silent, and AC-5.4 wants "refused as unavailable" |
| body `baseVersion` (D5) | `If-Match` + a CORS change | auth's CORS; the auth precedent |
| browser filter for the admin list (D12) | server `q` | size; fewer API shapes |
| server `q` for the attach picker, cap 50, exact match first (D13) | a browser-filtered list capped at 500 | a capped list cannot reach every team (AC-4.1); exact-first makes every team reachable whatever the cap |
| options mode on its own allowance + a per-caller limit (D11, D13) | one `teams` allowance for both modes | typed searches must not spend the budget decisions use |
| `existingName` in the 409 body (D14) | the English `detail` only; a localized `detail` | AC-3.3: the browser composes the message in its language |
| the page's fresh team read admitted per person (120) and in total (2 400), the page loading with markers and `teamsStatus` (D15) | a 429 of the page; the cache served over the limit; recording refused loads; a per-project or an auth-side limit | AC-5.6: the page loads and says why. Neither one person nor many can spend the decisions' allowance |
| `PUT /projects/{id}/teams` replaces the set | POST/DELETE per team | mirrors `PUT /projects/{id}/team`; one CAS on the project version |
| the cached path waits 800 ms and lets a slower flight finish into the cache; 800 + 1 000 margin < every 2 s caller, pinned across packages (D16) | the 5 s budget inside 2 s callers; one 800 ms timeout that aborts the flight; raising the callers' 2 s; a caller-sent deadline | a slow auth must cost one item's `assignees`, not the batch; an aborted flight never renews an entry; the provider sizes its own work (ADR 20261119) |

## Data model

### auth (step 1) — `prisma/migrations/20261126100000_teams/migration.sql`

```prisma
// A named group of users (specs/20261126-teams). Grants NOTHING: the resolver never reads it.
model Team {
  id          String    @id @default(cuid())
  name        String                       // trimmed, 1..80; unique case-insensitively (SQL index below)
  description String?                      // <= 500; empty is stored as NULL
  archivedAt  DateTime?                    // null = active (AC-1.5/1.6); never deleted (AC-1.7)
  version     Int       @default(1)        // name, description, state only (D6)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  members     TeamMember[]
  @@map("team")
}

model TeamMember {
  teamId        String
  team          Team     @relation(fields: [teamId], references: [id], onDelete: Restrict)
  userId        String
  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade) // users are soft-deleted; Cascade only for hard test cleanup
  addedByUserId String?  // convenience; the audit row is authoritative (no FK, as deletedByUserId)
  addedAt       DateTime @default(now())
  @@id([teamId, userId])
  @@index([userId])
  @@map("team_member")
}
// User gains: teamMemberships TeamMember[]
```

The SQL adds what Prisma cannot express, following the hours-api precedent
(`hours-api/prisma/migrations/20261113090000_init/migration.sql:74`):

```sql
CREATE UNIQUE INDEX "team_name_lower_key" ON "team" (lower("name"));
ALTER TABLE "team" ADD CONSTRAINT "team_name_shape"
  CHECK (char_length("name") BETWEEN 1 AND 80 AND "name" = btrim("name"));
ALTER TABLE "team" ADD CONSTRAINT "team_description_shape"
  CHECK ("description" IS NULL OR char_length("description") BETWEEN 1 AND 500);
```

Validation in code trims with JS `trim()` and checks `.length` (UTF-16, never shorter than
`char_length`), so the database is never stricter than the API. The **unique index decides a name
clash**: a `P2002` maps to 409 `team_name_taken`. A pre-check gives the common case its answer
without a failed write, as in departments (`departments.routes.ts:509-515`), and supplies the
409's `existingName` (D14). The pre-check and the re-read after a `P2002` both use
`lower("name") = lower($1)` in a parameterised raw query. They never use Prisma's
`mode: "insensitive"`, which emits `ILIKE`: `_` and `%` would be wildcards there, so "Back_nd" would
clash with "Backend". They also use the index. Archived teams are in the index, so "the rule
counts archived teams too" (AC-1.2) holds by construction. A purely additive migration.

### projects-api (step 2) — `prisma/migrations/20261126120000_attached_team/migration.sql`

```prisma
// A team (an auth team id, opaque) attached to a project. No name, no member: both live in auth (AC-1.3, O6).
model AttachedTeam {
  projectId  String
  project    Project  @relation(fields: [projectId], references: [id], onDelete: Cascade) // as ProjectMember
  teamId     String
  attachedAt DateTime @default(now())
  @@id([projectId, teamId])
  @@index([teamId])                         // the list filter (AC-4.8) and GET /attached-teams
  @@map("project_attached_team")
}
// Project gains: attachedTeams AttachedTeam[]
```

```sql
ALTER TABLE "project_attached_team" ADD CONSTRAINT "attached_team_id_shape"
  CHECK (char_length("teamId") BETWEEN 1 AND 64);
```

There is no NUL clause: a Postgres `text` value cannot hold a NUL at all, and `chr(0)` is itself an
error ("null character not permitted"), so the clause would not run and would add nothing. A NUL never
reaches this table anyway, because `PUT /projects/{id}/teams` writes only ids auth's read confirmed.

The 10-per-project limit is enforced by the route under the project's version CAS. Two writes on
the same project serialise on `version`, and each validates the whole set, so no database count is
needed. Additive. The existing `project_member` table is unchanged, as is the individual team
editor with its 100 limit (AC-4.6).

## API contracts

Errors are RFC 7807 with `code`. Every new answer carries `Cache-Control: no-store`.

**No NUL in ids and team text** (amendment 2026-11-27, QE D1). Postgres `text` cannot hold U+0000,
so a NUL that reaches a query is a 500, never a validation answer. The schemas therefore refuse it
before any database read or outbound call:

- **projects-api:** the shared `IdSchema` (`src/lib/http.ts`) is 1..64 characters **and contains
  no `"\u0000"`**. Every route that validates an id with it refuses a NUL: the path ids, the
  `teamIds` of `PUT /projects/{id}/teams`, the `teamId` filter of `GET /projects`, the host
  resolves' ids, and pre-existing ones such as the `projectManagerId` filter.
- **auth `/admin/teams*`:** the team `name` and `description` (create and `PATCH`), the `{id}` and
  `{userId}` path parameters and the body `userId` of `POST /admin/teams/{id}/members` contain no
  `"\u0000"`. The check is on the raw value, before trimming.
- **auth `GET /system/teams`:** `ids` and `q`, as already specified there.

A NUL answers **400 `validation_failed`**, in each route's existing refusal order (a 400 comes
before 404, 409 and 422). The body is the route's usual validation problem: it names the field and
the rule, and the submitted value never appears in `detail`, `errors` or `field` (no echo). Its
`instance` carries the request path, as every Problem in both services does, so a NUL in a path id
appears there; that is the services' standing RFC 7807 shape and this rule does not change it. No
value accepted before is refused, apart from one holding a NUL.

### auth — admin routes (step 1)

All routes run behind `sessionMiddleware, requireAuth, requireAdmin`, as departments do. That
means 401 unauthenticated and 403 for any non-admin, on every route including reads (AC-3.1).
Every successful change writes exactly one audit row through `withAudit({ affectedUserIds: [] })`,
so no `perm_epoch` bump (AC-2.5, AC-3.2). Refusals and no-ops write none.

```ts
type TeamSummary = { id: string; name: string; description: string | null; archived: boolean;
                     activeMemberCount: number; version: number }
type TeamMemberAdmin = { id: string; name: string; email: string; deactivated: boolean; addedAt: string /* ISO */ }
type TeamDetail = TeamSummary & { createdAt: string; updatedAt: string; members: TeamMemberAdmin[] }
  // members: name order (collator), deactivated last; deactivated ones are listed (AC-2.3)
```

| Route | Body | 2xx | Refusals |
|---|---|---|---|
| `GET /admin/teams` | — | 200 `{ items: TeamSummary[] }` (all, name order) | 401, 403 |
| `POST /admin/teams` | strict `{ name: string (trim, 1..80), description?: string (trim, ≤500; "" → null) }` | 201 `TeamDetail` | 400 `validation_failed`; 409 `team_name_taken` + `existingName` (*The name clash body*) |
| `GET /admin/teams/{id}` | — | 200 `TeamDetail` | 400 `validation_failed` (a NUL in `{id}`); 404 `team_not_found` |
| `PATCH /admin/teams/{id}` | strict `{ baseVersion: int ≥ 1, name?: …, description?: string \| null }`, at least one field | 200 `TeamDetail` (version + 1; unchanged values: 200, no bump, no audit) | in this order: 400; 404; 409 `version_conflict` `{ currentVersion }`; 409 `team_name_taken` + `existingName` |
| `POST /admin/teams/{id}/archive` | strict `{ baseVersion }` | 200 `TeamDetail` (already archived: no-op) | 400; 404; 409 `version_conflict` |
| `POST /admin/teams/{id}/restore` | strict `{ baseVersion }` | 200 `TeamDetail` (already active: no-op) | 400; 404; 409 `version_conflict` |
| `POST /admin/teams/{id}/members` | strict `{ userId: string (1..64, no NUL) }` | 200 `TeamDetail` (already a member: no-op) | 400 `validation_failed` (incl. a NUL in `{id}` or `userId`); 404 `team_not_found`; 422 `user_not_active` (unknown or soft-deleted; one body, AC-2.3); 422 `team_full` `{ limit: 100 }` (AC-2.4) |
| `DELETE /admin/teams/{id}/members/{userId}` | — | 200 `TeamDetail` (not a member: no-op) | 400 `validation_failed` (a NUL in `{id}` or `{userId}`); 404 `team_not_found` |
| `DELETE /admin/teams/{id}` | — | — | 405 `not_deletable`, `Allow: GET, PATCH` (AC-1.7) |

**The name clash body** (D14). It is produced in two places: `POST /admin/teams`, and
`PATCH /admin/teams/{id}` when the body carries a `name`. It is never produced by archive,
restore or the member routes, which do not change a name.

```json
HTTP/1.1 409 Conflict
Content-Type: application/problem+json
Cache-Control: no-store

{ "type": "https://httpstatuses.com/409", "title": "Conflict", "status": 409,
  "code": "team_name_taken",
  "detail": "A team named \"Backend\" already exists",
  "instance": "/admin/teams",
  "existingName": "Backend" }
```

- `existingName` is **required** in this body: a non-empty string, the other team's `name` exactly
  as stored (trimmed, its own casing), not the submitted text, except in the one race below. Given "Backend" stored, a create
  of "backend " answers `"existingName": "Backend"`. `detail` is built from the same value.
  `instance` is the request path (`/admin/teams/{id}` for a rename). In OpenAPI, the 409 response
  is a union by `code`: `version_conflict` requires `currentVersion`, and `team_name_taken`
  requires `existingName`.
- **How it is found.** It is computed inside the write's transaction, after the row lock and the
  version check, so a stale form gets `version_conflict` first. The pre-check is
  `SELECT "name" FROM "team" WHERE lower("name") = lower($1) AND "id" <> $self LIMIT 1`, where
  `$self` is the team being renamed; a create has no `$self`. A hit answers this 409 and writes
  nothing. With no hit, the write runs. If it still fails on `P2002` (a concurrent create or
  rename committed in between), the transaction has already rolled back. The same query then runs
  again, outside it (read committed), sees the committed winner, and that row's `name` is
  `existingName`.
- **The one race left.** If the winner was renamed between the failed write and that re-read, the
  re-read finds nothing. The 409 then carries the submitted trimmed name, which equalled the stored
  name ignoring case at the moment of the clash. No write is retried. One pure function,
  `nameTakenBody(existingName, path)`, builds the body on every path.
- A team renamed to its own name in another casing ("Backend" → "BACKEND") is **not** a clash,
  because the pre-check excludes `$self` and the index entry is the row's own. It is a change:
  version + 1, one audit row. A trimmed-equal name is the unchanged no-op.
- Exposure: the route is admin-only, and admins already list every team, archived ones included.
  The name comes from the database. In the one race it is the caller's own trimmed text, sent
  back to the caller only. admin-ui renders it as text.

Archived teams accept member changes (AC-2.4). `activeMemberCount` counts members whose
`user.deletedAt IS NULL`. Reactivation (by sign-in, `auth.config.ts:221-299`) counts them again
with no write (AC-2.3).

Audit rows have `targetType: "team"` and `targetId: <team id>`. The actions:

- `team.create`
- `team.update`, with `data: { before, after }` of `{ name, description }`
- `team.archive`
- `team.restore`
- `team_member.add` and `team_member.remove`, with `data: { userId }`. The summary names the
  person: `Added ada@welld.ch to team "Backend"`.

### auth — `GET /system/teams` (step 2)

```
GET /system/teams?ids=<id>,<id>,…          ids mode: 1..50 distinct ids, each ^[A-Za-z0-9_-]{1,64}$
GET /system/teams?state=active[&q=<text>]  options mode: active teams, names only; optional name search (D13)
(exactly one of ids / state; `q` only with state=active; anything else 400 `validation_failed`,
 fixed body, no echo)
q: no NUL; JS-trimmed; 1..80 characters after trimming (the name maximum); raw value at most 200.
   Empty after trimming, longer, or with a NUL → 400. projects-api omits an empty q and sends the
   trimmed text.

200 ids mode:
{ "items": [ { "id": "ckt…", "name": "Backend", "archived": false,
               "members": [ { "id": "u1", "name": "Ada Rossi", "active": true,  "appAccess": true  },
                            { "id": "u2", "name": null,        "active": false, "appAccess": false } ] } ] }
  // request order; an unknown id is omitted (teams are never deleted, so this is a bad id);
  // members in name order, inactive last; name null and appAccess false when !active;
  // appAccess = holds (<bound app>, "access"), bound app derived from the verified sub (projects)

200 options mode:
{ "items": [ { "id": "ckt…", "name": "Backend" } ], "truncated": false }
  // archived excluded; at most 50 (OPTIONS_LIMIT; 51 rows are read, truncated = a 51st exists).
  // without q: name order, then id.
  // with q: strpos(lower(name), lower(q)) > 0 (literal; % _ \ are not wildcards), ranked
  //   lower(name) = lower(q) first, then strpos = 1 (prefix), then the rest; each group by name, then id.
  // only id and name, as before: no member, no count, no description.

401  frozen body, identical for every credential failure (incl. a user JWT, a missing scope, a sub not in TEAM_READERS)
429  the one /system 429 (`systemRateLimits.tooManyRequests`)
```

The order follows `legalEntities/system.routes.ts`:

1. Verify the credential, with no I/O.
2. If it is invalid, consult the shared invalid-credential count per address. If it is valid,
   consult one allowance of the verified `sub` (D11). If an `ids` parameter is present, that is
   `teams`; otherwise it is `teamsOptions`. Only the parameter's presence is read at this point, and
   a malformed request still counts against the allowance of the mode it names.
3. Only then validate the query and read the database.

One log line per accepted call:
`[system] teams.read caller=<sub> mode=<ids|options> search=<yes|no> count=<n>`. The line never
holds an id, a name or the `q` text. A refusal after an allowance is spent uses
`logRefusal("allowance", "teams", sub)` for either mode.

### projects-api (step 2)

```ts
type TeamMemberView = { id: string; name: string | null; deleted: boolean; projectsAccess: boolean }
type AttachedTeamView = {
  id: string
  name: string | null            // null: the team could not be read (D9) or auth does not know it
  archived: boolean | null       // null together with name null
  members: TeamMemberView[] | null   // null: "could not be loaded" (AC-5.4)
}
// Project (existing view, projects.routes.ts:95-127) gains, after `team`:
teams: AttachedTeamView[]          // attach order
onProject: Person[]                // AC-4.4: PM, listed members, counted team members; each once
                                   // (when incomplete: the part that is known)
onProjectComplete: boolean         // false when an attached team's members could not be loaded
teamsStatus: "complete" | "unavailable" | "rate_limited"   // D15; see *The project view's team read*
teamsRetryAfterSeconds: number | null                      // integer 1..600 with "rate_limited", else null
```

| Route | Guard | Request | 2xx | Refusals |
|---|---|---|---|---|
| `PUT /projects/{id}/teams` | `authorized` + `requireCapability(PROJECT_MANAGE)`, `assertCanManage(entity)`, `If-Match` | strict `{ teamIds: IdSchema[] (max 10) }` | 200 `Project` + new `ETag` | 400 (incl. > 10, a NUL in an id); 403 `forbidden` / `out_of_scope`; 404; 409 `version_conflict`; 422 `team_not_found` `{ teamIds }`; 422 `team_archived` `{ teamIds }`; 428; 429 `rate_limited` `{ retryAfterSeconds }` (D15); 503 `teams_unavailable` |
| `GET /attachable-teams` | `authorized` + `requireCapability(PROJECT_MANAGE)` (any entity), then the per-caller limit | optional `q` (below) | 200 `{ items: {id, name}[], truncated }` (auth options mode, fresh, ≤ 50, D13) | 400 `validation_failed`; 403; 429 `rate_limited`; 503 `teams_unavailable` |
| `GET /attached-teams` | `authorized` | — | 200 `{ items: { id, name: string \| null, archived: boolean \| null }[] }`: distinct teams on ≥ 1 project, name order, unknown names last (cached path, fail soft) | 403 |
| `GET /projects?…&teamId=<id>` | unchanged | new optional `teamId: IdSchema` | 200, projects with that team attached (`attachedTeams: { some: { teamId } }`), local only | 400 |

`GET /attachable-teams[?q=<text>]` (D13) runs in this order:

1. `authorized` and `requireCapability(PROJECT_MANAGE)`: 403 `forbidden` before anything else, and
   no auth call.
2. The per-caller limit, keyed by `sub`: 120 per 10 min. Every request that reached this step
   counts. Over the limit → 429 `rate_limited` with `Retry-After` and no auth call.
3. `q` validation: at most 200 characters raw and no NUL (`"\u0000"`, the rule of *No NUL in ids
   and team text* above), then
   JS-trimmed, at most 80 after trimming, otherwise 400 `validation_failed` and no auth call. An
   absent `q`, or one that is empty after trimming, means "no search". The browser never sends
   more than 80 characters, because it answers "no match" itself (`design.md` S7).
4. One fresh call: `GET /system/teams?state=active` plus `&q=<trimmed>` when there is a search,
   never cached, 5 s, `redirect: "error"`, body ≤ 1 MiB, and 401 → drop the token and retry once.
   A timeout, an auth 429, a 401 after the retry or a malformed answer → 503
   `teams_unavailable`.
5. 200 with auth's `items` and `truncated` as they came, and `Cache-Control: no-store`. The
   already-attached ids are not removed by the server; the dialog leaves them out (design G2 (c)).

`PUT /projects/{id}/teams` runs in the order of `team.routes.ts:49-83`:

1. `requireIfMatch`, load the row, `assertCanManage`, `assertVersion`.
2. When the new set is not empty, `admitTeamRead(sub)` is consulted (D15). If it admits, **the whole
   new set** (≤ 10 ids) is read from auth in one fresh call, and only the **added** ids are judged:
   - unknown → 422 `team_not_found`;
   - archived → 422 `team_archived`;
   - auth cannot answer → 503 `teams_unavailable` when an id is added. With none added, the write
     goes on and step 4's view says `"unavailable"`.

   An already-attached archived team may stay (AC-4.2). If it does not admit and an id is added, the
   answer is 429 `rate_limited` (the person's window, body below) or 503 `teams_unavailable` (the
   service's), and nothing is written. If it does not admit and no id is added, the write goes on
   and step 4 answers the view that was not admitted. An empty new set reads and counts nothing.
3. Transaction: version CAS `updateMany({ where: { id, version } })`, `deleteMany` of the removed
   teams, `createMany` of the added ones.
4. Answer with the view built from step 2's answer, with no second call, and `ETag`. The PUT
   therefore makes at most one auth call and counts once. A team id never goes through `requireProjectUsers`. A
   person and a team are different ids in different fields, so a team id sent as
   `projectManagerId` or in `memberIds` fails the existing app-access-check as an unknown user (422
   `not_project_user`, AC-4.9).

**The person's 429 on `PUT /projects/{id}/teams`** (D15). It is the only 429 of a project write:

```json
HTTP/1.1 429 Too Many Requests
Content-Type: application/problem+json
Retry-After: 431
Cache-Control: no-store

{ "type": "https://httpstatuses.com/429", "title": "Too Many Requests", "status": 429,
  "code": "rate_limited", "detail": "Too many team reads. Try again later.",
  "instance": "/projects/<id>/teams", "retryAfterSeconds": 431 }
```

`retryAfterSeconds` (required, integer 1..600) equals the header. It is in the body because the
browser cannot read `Retry-After` across projects-api's CORS. It is the caller's own window, so it
tells them nothing about anyone else.

**The project view's team read** (D15, AC-5.4, AC-5.6). Every answer that carries a `Project` sets
these fields together. The rest of the view (people, company, deal, purchase order, terms, `ETag`,
`no-store`) does not depend on them.

| Case | each `teams[i]` | `onProject` | `onProjectComplete` | `teamsStatus` | `teamsRetryAfterSeconds` |
|---|---|---|---|---|---|
| no attached team (nothing read, nothing counted) | (`teams: []`) | PM + listed | `true` | `"complete"` | `null` |
| admitted, every team read (fresh, or from an entry ≤ 60 s old after a failed refresh) | name, archived, members | + counted members | `true` | `"complete"` | `null` |
| admitted, the read failed and a team has no usable entry | that team `members: null`, with `name`/`archived` from an entry when one is held, else `null` | PM + listed + counted members of the teams that were read | `false` | `"unavailable"` | `null` |
| not admitted: the service's window (2 400) | `{ id, name: null, archived: null, members: null }` | PM + listed | `false` | `"unavailable"` | `null` |
| not admitted: the person's window (120) | `{ id, name: null, archived: null, members: null }` | PM + listed | `false` | `"rate_limited"` | seconds until the person's oldest admitted read leaves the window, rounded up, 1..600 |

Invariants, pinned by schema tests:

- `teamsStatus === "complete"` exactly when `onProjectComplete === true`;
- `teamsRetryAfterSeconds !== null` exactly when `teamsStatus === "rate_limited"`;
- `"rate_limited"` only when `teams` is not empty;
- the status is always 200 (an over-limit person's page is never a 429).

`teamsStatus` is a closed enum. A new value is a contract change, and projects-ui reads an unknown
value as `"unavailable"`.

**Host contracts (changed answers, same routes):**

- `POST /activity-host/v1/resolve`: `assignees` is `onProject(...)`, or **`null`** when a project
  has attached teams whose members are unavailable (D3). For a non-reader nothing changes:
  `missing` items, and no team read.
- `POST /meeting-host/v1/resolve`: `hostVisible = onProject(...).includes(caller)`. When that needs
  a team read that is unavailable, the answer is 503 `teams_unavailable` (D3).
- Neither resolve consults the D15 windows, whoever the caller is. A person over their page limit
  is still answered from the cached path (AC-5.6).

**Consumer contract changes:**

- activities-api: wire `assignees: string[] | null | undefined`. From a `host_list` host,
  `undefined` stays malformed and `null` is internal `"unavailable"`. `assertAssignable` throws 503
  `host_unavailable` on it, while reads and an unchanged resent assignee (AC-3.7 of 20261110) are
  unaffected.
- hours-api: wire `assignees: string[] | null`, and `assertOnProject` refuses `null` with 503
  `host_unavailable`. Labels still resolve.

### UI surface

- **admin-ui**
  - `/admin/teams` is a `PageHeader` with a New team button and a `DataTable` (name with a link,
    active members, state `StatusBadge`), a search field, and an Active / Archived / All filter
    (active by default).
  - A 409 `team_name_taken` in the create or edit dialog puts `form.nameTaken(existingName)` on the
    Name field, in `en` or `it`. A 409 without a string `existingName` is shown as the generic
    `createFailed` / `saveFailed`, never as a clash without a name (`design.md` F1, S2, G1).
  - `/admin/teams/$id` holds name and description (edit through `FormDialog` with `baseVersion`; a
    409 `version_conflict` shows the stale banner and keeps the typed values), Archive / Restore through
    `ConfirmDialog`, and the members list with name, email, "Deactivated" badge and added date via
    `formatDate`. Add a member with the user search `listUsers({ q, pageSize: 10 })`, which lists
    active users only. Removing a member asks for confirmation.
  - There is no delete control.
  - `SectionNav`: Roles, Departments, **Teams**, Users | Audit.
  - `ADMIN_SEGMENTS` gains `teams`. A legal-entity manager who is not an admin is redirected to
    `/legal-entities`, and anyone else is denied (`gateFor`, `AdminShell.tsx:102-118`).
  - Dialogs are mounted beside any page form, never inside it (ADR 20261118-a-dialog-that-renders-…).
- **projects-ui**
  - The Team card keeps "Team" with two sections, People (unchanged editor) and Teams (O11). Each
    team shows its name, an "Archived" badge, and its members with "Deactivated" and "No access to
    Projects" badges, or "Members could not be loaded" / "Team could not be loaded".
  - For `canManage`, an **Edit teams** button opens `TeamsDialog` (`design.md` S7). Its **Attach a
    team** field is a `SearchPicker` whose `search(q, signal)` calls `GET /attachable-teams?q=`
    with the trimmed text (empty means the first teams) and leaves out ids already attached or
    staged. Nothing is fetched when the dialog opens. Text over 80 characters is answered "no
    match" without a request. `truncated` adds a "type more of the name" hint. A 403 maps to
    forbidden; a 503, a 429 or a network error maps to unavailable, never "no match". The dialog
    lists the attached teams with Remove and stops at 10 with the limit named. It saves with the
    project's version: a 409 → `onStale`; 422 → inline; 503 → inline "Teams could not be loaded";
    429 `rate_limited` → inline "too many requests, nothing was changed, try again later" (D15; the
    copy is the designer's, see below).
  - The Team card reads `teamsStatus` (D15, AC-5.6):
    - `"rate_limited"`: every team block is marked as when its members are `null` ("Team could not
      be loaded" / "Members could not be loaded"). One banner at the top of the Teams section says
      the person made too many requests and should try again later; it may use
      `teamsRetryAfterSeconds`, rounded up to minutes. This banner replaces "Some teams could not
      be loaded". A Retry is harmless (a refused load is neither recorded nor calls anything), but
      it succeeds only after the wait.
    - `"unavailable"`, or any unknown value: the AC-5.4 rendering.
    - `"complete"`: the loaded rendering.

    The assignee hint and the Record hours offer follow `onProject` and `onProjectComplete`, as in
    AC-5.4. A team-only person over their limit is therefore not offered Record hours on the page
    until the wait is over. That is a convenience only: hours-api still decides, and My hours still
    records. The copy (`en` + `it`) of the banner and of the dialog's 429 is not in `design.md` yet
    (drift for the designer).
  - `TaskFormDialog` offers `project.onProject` (non-deleted). When `onProjectComplete` is false it
    shows a note that some team members could not be loaded.
  - `mayRecordOnProject` uses `project.onProject`.
  - `ProjectsPage` gets a Team `<select>` fed by `GET /attached-teams`, as the PM filter is fed by
    `/project-managers`.
  - Strings are `en` + `it` in the strings modules, the existing parity and hardcoded-copy tests
    cover them, and dates use the library formatters only.

## Test strategy

Backend tests run against the test database, never the dev one (user memory). Every AC maps to at
least one test. The table was checked AC by AC against the spec (31 ACs: US-1 ×8, US-2 ×5, US-3
×3, US-4 ×9, US-5 ×6; AC-5.6 added on 2026-11-26).

| AC | Level | What proves it |
|---|---|---|
| AC-1.1 | auth integration; admin-ui component; e2e | `teams/admin.routes.test.ts`: POST with a padded 1..80 name and ≤ 500 description → 201, `archived:false`, 0 members, listed by GET; 0/81 chars and 501 → 400. `TeamsPage.test.tsx` create dialog → row active, 0. `admin-teams.spec.ts` |
| AC-1.2 | auth integration + unit; admin-ui component | `teams/admin.routes.test.ts`: create "Backend"; create "backend " and "BACKEND", and rename another team to "backend " → 409 whose body **deep-equals** the shape in *The name clash body*, with `existingName: "Backend"` (the stored casing, not the submitted) and `instance` the request path; team rows, audit rows and the renamed team unchanged; repeat with "Backend" archived. Order: a PATCH with a stale `baseVersion` and a clashing name → `version_conflict`. Not a clash: renaming "Backend" to "BACKEND" itself → 200, version + 1, one audit row; with "Back_nd" stored, creating "Backend" → 201 (no wildcard). Race: two concurrent creates of "Ops" and "ops" → one 201 and one 409 whose `existingName` is the winner's stored name (the `P2002` re-read path). Raw-SQL insert of a clashing lower() name → unique violation (the index decides). Unit: `nameTakenBody` and the re-read-miss fallback (submitted trimmed name). OpenAPI contract: the 409 `team_name_taken` schema requires `existingName`. `TeamFormDialog.test.tsx`: the message names the existing team and keeps the form; a 409 `team_name_taken` without `existingName` → generic failure |
| AC-1.3 | projects-api integration; e2e | stubbed auth answers "Backend" then "Platform": two consecutive `GET /projects/{id}` show "Backend", then "Platform" (fresh read). Schema test: `project_attached_team` has no name column. e2e: rename in Admin, reload the project page, new name |
| AC-1.4 | auth integration; admin-ui component | `activeMemberCount` excludes a soft-deleted member; `archived` flag. `TeamsPage.test.tsx`: default active only, Archived and All filters, case-insensitive substring search ("ACK" finds "Backend") |
| AC-1.5 | auth integration; projects-api integration | archive keeps members and description; the options mode excludes it with and without `q`, including when `q` is its whole name. projects-api: `/attachable-teams` passes through the options mode (stub); a project with the team attached is unchanged after archive and still counts its members (`onProject` vector "archived team counts") |
| AC-1.6 | auth integration | restore → `archived:false`, back in the options mode and found by `q` |
| AC-1.7 | auth integration; admin-ui component | `DELETE /admin/teams/{id}` → 405 `not_deletable`, row present, no audit; no delete control on TeamsPage or TeamDetail (no button, no `team-delete-*` test id) |
| AC-1.8 | auth integration; admin-ui component | PATCH, archive and restore with a stale `baseVersion` → 409 `version_conflict` + `currentVersion`, nothing changed, no audit; missing `baseVersion` → 400. Two parallel PATCHes on the same version → exactly one 200. TeamDetail: 409 → reload banner, typed values kept |
| AC-2.1 | auth integration; admin-ui component; e2e | add an active user → listed and counted; the same user in a second team; re-add → no-op, no audit. TeamDetail add via user search |
| AC-2.2 | auth integration | remove → gone from this team only; the second team unchanged |
| AC-2.3 | auth integration | add a soft-deleted user → 422 `user_not_active` (same body as an unknown id); soft-delete a member → listed `deactivated:true`, not counted; clear `deletedAt` → counted again |
| AC-2.4 | auth integration | 100 members → add → 422 `team_full {limit:100}`; two concurrent adds at 99 → one 200, one 422 (row lock); add to an archived team → 200 |
| AC-2.5 | auth integration + static | for each team write: `resolveEffectivePermissions` before = after, `permissionEpoch` unchanged, `user_role` / `user_department` unchanged. A source test asserts `resolver.ts` references neither `team` nor `teamMember` |
| AC-3.1 | auth integration; admin-ui component; e2e | every `/admin/teams*` route: 401 unauthenticated, 403 for a non-admin (including a department-conferred admin, since `requireAdmin` is direct only), 200 for an admin. Catalog unchanged (`uniqueResourceKeys.test.ts` / catalog snapshot). `SectionNav.test.tsx`: no Teams tab without `admin:access`; `AdminShell` / router test: `/teams` redirects a legal-entity manager to `/legal-entities`, denied otherwise. e2e: a non-admin sees no Teams entry |
| AC-3.2 | auth integration | each successful write → exactly one `audit_log` row (actor, action, `team`, team id; `data.userId` for membership); every refusal (400/403/404/405/409/422) and every no-op → zero rows |
| AC-3.3 | admin-ui unit + component | `strings.test.tsx` parity (`catalogGaps`) covers `teams`, including `form.nameTaken`; `noHardcodedStrings.test.ts` scans the new pages; TeamDetail renders the added date through `formatDate` (dd.mm.yyyy) in `it` and `en`; `TeamFormDialog.test.tsx` renders the 409 `existingName` message in `it` and `en` and never shows the server's `detail` |
| AC-4.1 | auth integration; projects-api integration (+ matrix); projects-ui component; e2e | PUT with `If-Match` → 200, `ETag` bumped, view shows the team; other entity → 403 `out_of_scope`; stale → 409; 11 ids → 400; detach → 200 + new `ETag`. Matrix rows for the routes. **Reach (D13), auth:** `q` "ACK" finds "Backend" (case-insensitive substring); 60 active teams whose names contain "a" and sort before a team named "A" (`0a-01` … `0a-60`) → `q` "a" answers 50 items, `truncated:true`, "A" first (exact first); prefix before other matches; `%`, `_` and `\` are literal ("50%_off" is found by "%_", "_" does not find "Backend"). **projects-api:** `q` " Back " reaches the stub as `q=Back`; empty or blank `q` reaches it with no `q`; 81 characters after trimming, 201 raw, or a NUL → 400 with no stub call; `truncated` passed through. `TeamsDialog.test.tsx`: typing searches through `GET /attachable-teams?q=`, nothing is fetched on open, attached and staged ids are left out, more than 80 characters → "no match" with no request, `truncated` → the hint, 503 and 429 → unavailable, attach, detach, limit named at 10, 409 → stale. e2e: the PM finds the team by typing part of its name |
| AC-4.2 | projects-api integration | add an archived team → 422 `team_archived`; a PUT keeping an attached archived team → 200 |
| AC-4.3 | projects-api integration; projects-ui component; e2e | a reader without `project:manage` gets `teams[].members` with names, `deleted:true` (name null) and `projectsAccess:false`. `TeamCard.test.tsx` (new): People and Teams sections, the three badges. e2e reads the card |
| AC-4.4 | unit; projects-api integration | `onProject.test.ts` vectors: PM null; a person in two teams and listed → once; order; a no-access member excluded; a deactivated member excluded. activity-host test: `assignees` equals the vector |
| AC-4.5 | unit; projects-api integration | vectors: detach a team → a listed person stays, a team-only person leaves; activity-host after PUT |
| AC-4.6 | unit (fake clock); e2e | `teams.test.ts`: entry sent at t used until t + 30 s, refreshed after; refresh fails → used to t + 60 s with `teams_stale_used`, then unavailable; stamp is the SEND time (a 4 s answer does not extend the age); single flight; piggyback of entries > 15 s; 401 → token dropped, one retry. D16: an answer that arrives after a `cached()` call stopped waiting is stored with its own send stamp, and nothing older than 60 s is used (*Further tests*, host-path wait). Existing "never cached" tests in activities-api and meetings-api stay green. e2e: remove a member, `expect.poll` ≤ 65 s until hours is refused |
| AC-4.7 | auth integration + contract; unit; projects-api integration | auth: a member without `(projects, access)` → `appAccess:false`; grant a role → `true` on the next call. Contract: `holdersOfAppAccess` = `resolveEffectivePermissions(...).some(...)` for direct, department-conferred, conditioned, none and soft-deleted fixtures. The view keeps the team attached and marks the member; `onProject` excludes them |
| AC-4.8 | projects-api integration; projects-ui component | `GET /projects?teamId=` lists only projects with that team; `/attached-teams` lists only teams on ≥ 1 project (incl. archived), once each. `ProjectsPage.test.tsx` filter |
| AC-4.9 | projects-api integration; projects-ui component | PATCH/POST `projectManagerId` = a team id → 422 `not_project_user` (stubbed app-access-check: ineligible); the PM picker offers only the directory's people |
| AC-5.1 | hours-api unit; e2e | `bookability.test.ts`: `assignees` with a team-only person → accepted; `null` → 503 `host_unavailable`. e2e `projects-teams.spec.ts`: a team-only person records hours (accepted); removed from the team → a new entry is 422/403 `not_on_project` after the poll; the earlier entry is unchanged |
| AC-5.2 | activities-api integration; projects-ui component; e2e | stub host with the team-only person in `assignees` → task created assigned to them; `null` → 503 on create/reassign, 200 on list; after leaving, the task keeps its assignee and an unchanged resend is accepted. `TaskFormDialog.test.tsx` offers `onProject`. e2e assigns a task to a team-only person |
| AC-5.3 | projects-api integration | meeting-host: a team-only reader → `hostVisible:true`; removed (fresh entry) → `false`; a member without Projects access is not a reader (`closed`). meetings-api is unchanged: its contract test for `hostVisible` stays green |
| AC-5.4 | projects-api integration; consumer unit; projects-ui component | auth stub failing: activity-host → `assignees:null` for projects with teams and the listed set for those without (never listed-only for a project with teams); meeting-host → 503 `teams_unavailable` (the PM is still answered); `GET /projects/{id}` → 200 with `members:null`, `onProjectComplete:false`, `teamsStatus:"unavailable"`, `teamsRetryAfterSeconds:null`. A `PUT …/teams` that only removes, with auth failing → 200, committed, `"unavailable"`. hours-api and activities-api `null` tests (above). `TeamCard.test.tsx` renders "could not be loaded" and never the too-many-requests banner. **Slow, not failing (D16):** with the auth stub holding its answer past 2 s, the activity-host resolve answers 200 within `TEAMS_HOST_WAIT_MS + TEAMS_HOST_MARGIN_MS`, with `assignees:null` for the project with teams and the listed set for the one without; the meeting-host resolve answers 503 `teams_unavailable` for a team-only caller within the same bound |
| AC-5.5 | projects-api integration | a team-only person holding only `projects:access` → PATCH project, PUT team, PUT teams → 403 `forbidden` |
| AC-5.6 | projects-api integration (fake clock, an auth stub that counts calls); projects-ui component; e2e | `teams.pageLimit.test.ts`. **The limited person's page:** person P makes 120 `GET /projects/{id}` of a project with a team → 120 stub calls, each `"complete"`. The 121st → 200 with every team `{name:null, archived:null, members:null}`, `onProject` = PM + listed, `onProjectComplete:false`, `teamsStatus:"rate_limited"`, `teamsRetryAfterSeconds` = the remainder, and people, company and `ETag` intact. It makes **no stub call** and serves no cache entry, although one is fresh (the stub's earlier answer is not shown). Reloading while over → still refused, the stub untouched, and the retry time does not move (refused loads are not recorded). Advance the clock past the oldest admitted read and make the stub answer "Platform" → the next load is `"complete"` and shows "Platform" (AC-1.3). **Another person unaffected:** with P over, person Q's view of the same project → `"complete"`, one stub call. **Decisions unaffected:** with P over, the activity-host resolve (caller P, then Q) still has the team-only member in `assignees`; the meeting-host resolve for a team-only reader who is over their own limit → `hostVisible:true`; a spy shows neither resolve consults the windows; hours-api and activities-api see no 503. A project with no team: P over still gets `"complete"`, and nothing is counted. **Writes with P over:** PATCH commits (version + 1) and answers the degraded view; `PUT …/teams` adding a team → 429 `rate_limited` with `retryAfterSeconds` equal to `Retry-After`, nothing written; `PUT …/teams` only removing → 200, committed, degraded view. **Counting position:** a 403 (`authorized` refused), a 404, a 409 and a 428 count nothing; a `PUT …/teams` costs one stub call and one count. **Service window** (test-sized windows installed by `resetWorld()`): once it is full, a person under their own limit gets `"unavailable"`, not `"rate_limited"`; a `PUT …/teams` adding a team → 503 `teams_unavailable`; the host resolves still answer from the cache. `TeamCard.test.tsx`: `"rate_limited"` → the too-many-requests banner and "could not be loaded" on every team; `"unavailable"` → the AC-5.4 banner only; an unknown value → as `"unavailable"`. `TeamsDialog.test.tsx`: a save 429 → the inline too-many-requests message, the dialog stays open, nothing changed. e2e `projects-teams.spec.ts`: a dedicated persona, used by no other spec, makes 120 API reads of the project and then opens it → banner and markers. Meanwhile the admin's page shows the team and its members, and the team-only person's hours entry is accepted |

Further tests with no AC of their own:

- **auth `GET /system/teams`**:
  - every credential failure gives the identical 401 (no header, user JWT, wrong audience, missing
    scope, a `sub` not in `TEAM_READERS`);
  - verify happens before count, and a refused request reads no row;
  - the allowance gives the one 429;
  - ids capped at 50, unknown ids omitted, `no-store` on every answer;
  - `q` with `ids` → 400; `q` empty after trimming, longer than 80, over 200 raw, or with a NUL → 400 with the
    fixed body (sentinel: the text is not echoed);
  - the two allowances (D11): a spent `teamsOptions` gives the 429 to the options mode while the ids mode still
    answers 200, and the reverse; a malformed request counts against the allowance of the mode it names; a refused
    request reads no row;
  - the log line holds no id, no name and no `q` text (sentinel `q`);
  - `systemRateLimits.test.ts` and `systemCapacity.contract.test.ts` gain the route and both allowances.
- **projects-api `GET /attachable-teams` limit (D13)**: the 121st request of a caller within the window → 429
  `rate_limited` + `Retry-After` and no stub call; another caller is unaffected; requests refused by the guard (403)
  are not counted; malformed ones (400) are; the limiter is reset per test by `resetWorld()`. An auth 429, a
  timeout or a second 401 → 503 `teams_unavailable`.
- **projects-api team-read windows (D15)**:
  - `rateLimiter.test.ts`: `peek` records nothing; a refused `consume` records nothing; `admitTeamRead` records in
    both windows or in neither (person full, service full, both full); the remainder is rounded up to 1..600 s;
    fake clock;
  - a constant test pins 120, 2 400 and 600 000 ms, and that the windows are distinct from D13's attach-search limiter
    (a person at 120 searches still loads pages, and the reverse);
  - the refusal log line appears once per person and window, holds the actor id, and holds no project id, team id or
    name (sentinels); `resetWorld()` resets both windows;
  - `projects.schemas` test: the four invariants of *The project view's team read*; the OpenAPI `ProjectSchema` requires
    `teamsStatus` and `teamsRetryAfterSeconds`, and the `PUT …/teams` 429 requires `retryAfterSeconds`.
- **No NUL (QE D1, amendment 2026-11-27)**: the QE files `auth/src/teams/admin.nul.qe.test.ts` and
  `projects-api/src/projects/teams.nul.qe.test.ts` prove 4xx, never 5xx, for a NUL in the create
  name and description, the `PATCH` name, the member `userId` (body and path), the `{id}` of
  `GET /admin/teams/{id}`, `GET /projects?teamId=` and a team id of `PUT /projects/{id}/teams`. The
  routes' own tests pin the exact answer: 400 `validation_failed`, the value absent from the body
  (sentinel), nothing written, and on projects-api no auth call; `IdSchema`'s refusal is tested once
  where it is defined and once through the pre-existing `projectManagerId` filter.
- **serviceClients**: `teams:read` is known; `DOCUMENTED_CLIENT_SCOPES` pins projects-api's six
  scopes.
- **env-doctor**: `check.test.ts` `PROJECTS_SCOPES` and the manifest.
- **projects-api matrix**: rows for the three new routes, and the `/system/` inventory unchanged. The
  `GET /attachable-teams` row stays need `manage-any`; its probe sends `?q=back`, and the refused personas
  (outsider, viewer, accounting) must cause no call to the auth stub (the guard runs before the limit and the
  search). The matrix's few calls per persona stay far below the per-caller limit. Every 200 that carries a
  `Project` has `teamsStatus`. A refused persona (403) on `GET /projects/{id}` or on a write leaves its D15 window
  untouched.
- **projects-api host-path wait (D16, amendment 2026-11-27)**:
  - **Cross-package constants, new file `projects-api/src/lib/teams.budgets.cross-package.test.ts`.**
    It mirrors `accounting-api/src/budgets.cross-package.test.ts`. The three consumer files cannot be
    imported (each evaluates its own `env` and resolves its own `node_modules`), so each is read as
    text. A reader `deadlineOf(source, name)` accepts exactly one `export const <name> = <n | n * n>;`
    and throws otherwise. A missing file or declaration is a FAILURE, never a skip. The tests:
    - the reader accepts a number, a number with separators and a product. It refuses an absent, a
      non-exported, a repeated and a non-literal declaration;
    - it reads `activities-api/src/hosts/client.ts` `RESOLVE_TIMEOUT_MS`,
      `meetings-api/src/hosts/client.ts` `RESOLVE_TIMEOUT_MS` (exported by this change) and
      `hours-api/src/clients/owner.ts` `OWNER_TIMEOUT_MS`, and each equals 2 000;
    - for each of the three, `TEAMS_HOST_WAIT_MS + TEAMS_HOST_MARGIN_MS < deadline`;
    - order and pins: `TEAMS_HOST_WAIT_MS < TEAMS_TIMEOUT_MS`, and the values 800, 1 000 and 5 000;
    - static: `activity-host.routes.ts` and `meeting-host.routes.ts` read teams only through
      `teamReader.cached(` and contain no `.fresh(` or `.options(`, because a host route moved to the
      page path would silently be back on 5 s. A planted source string proves the check can fail.
  - **Unit, `projects-api/src/lib/teams.test.ts`.** These use a stub fate that holds its answer until
    the test releases it, real timers, and a test-sized `hostWaitMs` reader option (default
    `TEAMS_HOST_WAIT_MS`):
    - a flight unanswered at the wait, with no entry → `cached()` returns at the wait (not before it,
      and well before `timeoutMs`), the id is unavailable, and `teams_unavailable` is logged with
      `wait_exceeded`;
    - the same with an entry of at most 60 s → the entry is used and `teams_stale_used` is logged;
      with an entry over 60 s → unavailable;
    - the flight is not aborted: released after the wait and before `timeoutMs`, it stores the entry
      stamped with its send time. The next `cached()` within 30 s makes no call and returns the fact;
    - a `cached()` that starts while that flight runs joins it (no second call) and gets its own full
      wait;
    - one wait per call: 120 ids in three held chunks → returns once at about the wait, not three
      times it;
    - every flight answering before the wait → returns at once, the same as today (the existing tests
      stay green);
    - a flight still running at `timeoutMs` fails as today and is not remembered;
    - `fresh()` and `options()` ignore the wait: an answer released after `hostWaitMs` and before
      `timeoutMs` is returned as a fact or as options;
    - the stub's call count is the same with and without the wait (no extra call to auth).
  - **Integration, new file `projects-api/src/projects/teams.hostWait.test.ts`.** It runs on the test
    database, with the real constants and an auth stub that holds `/system/teams`:
    - an activity-host resolve of two projects, one with an attached team (no entry) and one without,
      with the stub held past 2 s → 200, with elapsed ≥ `TEAMS_HOST_WAIT_MS` − 100 and
      < `TEAMS_HOST_WAIT_MS + TEAMS_HOST_MARGIN_MS`. The project with the team has `assignees:null`;
      the other has its listed set. Release the stub, and a second resolve within 30 s → the team
      member is in `assignees`, with no new stub call;
    - with an entry 40 s old (`advanceTeamsClockForTests`) and the stub held → the resolve answers
      the team member from the entry within the same bound, and `teams_stale_used` is logged;
    - a meeting-host resolve with the stub held: a team-only caller → 503 `teams_unavailable` within
      the bound; the PM → 200 with no stub call;
    - `GET /projects/{id}` with the stub answering after 1.5 s (over the wait, under 5 s) →
      `teamsStatus:"complete"` with the members, because the page path is not bound by the host wait.
  - No consumer test changes. activities-api, meetings-api and hours-api keep their 2 s and their
    timeout → `unavailable` tests; the cross-package test is what relates them to projects-api.
- **Migration tests**: projects-api's applies on a database at `20261124160000`; auth's on its
  predecessor.

## Risks

| # | Risk | Mitigation / early check |
|---|---|---|
| R1 | The projects-api `onProject` rule and auth's `appAccess` predicate drift from app-access-check's meaning | the contract test (AC-4.7) runs both over shared fixtures; `holdersOfAppAccess` lives beside `resolveEffectivePermissions` in `resolver.ts` |
| R2 | Projects with teams now depend on auth's team read for decisions (availability) | cache with 60 s fallback; `assignees:null` keeps reads up (D3); allowance with 10× headroom (D11), of which page reads may spend at most 2 400 (D15); `teams_stale_used`, the 503 counts and the D15 refusals are logged; a slow auth costs per item, not the batch, because the host path waits 800 ms inside its callers' 2 s (D16). Early check: load test of 25-project My tasks with 10 teams each against a local auth |
| R3 | Worst-case answer size: 25 projects × (1 + 100 + 10×100) assignees ≈ 0.8 MB per activity-host resolve | no consumer caps the body today; realistic sizes are two orders smaller. If it ever matters, the trigger is a cap on distinct team members per project |
| R4 | An admin adding someone to a team silently widens meeting-content readers on every project the team is on (O8) | accepted by the user; the audit row records the add; the Security review covers it; the projects page shows who is there through the team |
| R5 | Deploy skew: granting `teams:read` before auth knows it stops auth (unknown scope refuses to start, `serviceClients.ts:209-216`) | Delivery order; the runbook step says "after the step-2 auth is live" |
| R6 | projects-ui deployed before projects-api reads `project.onProject` as undefined | projects-ui after projects-api (Delivery), plus a defensive `onProject ?? [PM, ...team]` until the next release, test-pinned |
| R7 | `lower()` (Postgres collation) and JS case folding differ for some characters | the unique index decides (409 from `P2002`); the pre-check is only for the message |
| R8 | e2e "leaves the team" needs up to 60 s | one `expect.poll` (≤ 65 s) in one journey; no test-only cache switch (it would be an env var nobody may set in production) |
| R9 | projects-api's cached service token lacks `teams:read` for ≤ 5 min after the grant | 401 → invalidate + one retry (D2) |
| R10 | Admin list unpaginated (D12) | trigger: more than ~500 teams. The attach picker is not affected: it searches on the server (D13) |
| R11 | Caller-driven volume on the shared team read. The attach search sends a request per settled text, and a page view sends a fresh ids call | **Closed 2026-11-26** by AC-5.6 and D15. The search has its own allowance (`teamsOptions`) and a per-caller limit (D11, D13). The page's fresh read is admitted per person (120 per 10 min) and in total (2 400 per 10 min). Page reads therefore leave at least 600 of the 3 000 to the cached decision path, which is never limited per person. Residual: replicas (R12). Early check: the D11 load test counts page views, and asserts that projects-api never makes more than 2 400 fresh ids calls in a window |
| R12 | Every limiter of this plan is per process (D13, D15). A second projects-api replica doubles them, and 2 × 2 400 exceeds the `teams` allowance | projects-api runs one replica (`.railway/railway.ts`). A second replica must first divide the figures by the replica count, or move the windows to a shared store (the `RateLimiter` seam). A comment at the constants and an ADR A1 escalation trigger say so |
| R13 | Two pre-existing deadline nestings that D16 does not fix. (a) projects-api's `/authz/resolve` client waits 5 s (`src/authz/resolveClient.ts:20`), so on a cold permission cache against a slow auth a host resolve can outlast its 2 s caller before the team read starts. (b) hours-api (2 s) → activities-api `GET /activities?ids=` → projects-api (activities-api's 2 s): the inner deadline equals the outer. Also, with auth slow beyond 0.8 s, a team nobody read for over 60 s is unavailable for the first decision on it | (a) and (b) are not team reads and are out of this feature: they are routed to the caller as findings for their owners (the host-contract services). D16 makes neither worse: on a warm permission cache the 800 ms wait plus its margin fits inside both. For the last case, the flight that decision started fills the cache, so the retry the 503 asks for succeeds. Early check: the D16 integration test with a held stub |
| R14 | Every resource server reloads auth's JWKS inline every 10 min with a 5 s timeout, so one request per process per 10 min can outlast a 2 s caller when auth is slow; a failed reload is a 401 (on a page, the shell's refresh-retry-redirect). Recorded 2026-11-27, after the feature closed, from the R12/R13 follow-up (`r12-r13-decision.md`) | Open, owner-accepted as a recorded risk: fixing it trades key-revocation latency and belongs to auth/platform. Also the comment in `*/src/auth/jwt.middleware.ts` claiming jose honours `Cache-Control: max-age=3600` is wrong for jose 6. R12 and R13 themselves are being fixed as a follow-up after the close, per `r12-r13-decision.md` |

## Security

**Security-sensitive: YES.** The feature changes authorization-relevant data and who may read
the suite's most sensitive content:

- **Widening of meeting-content readers (AC-5.3, O8, accepted knowingly).** Team membership,
  edited by admins in another tool, now decides `hostVisible` on projects. That covers up to 10 ×
  100 people per project instead of ≤ 101, and it changes without any project write.
- **A new cross-service credential path.** auth's `GET /system/teams` (scope `teams:read`, `sub`
  binding, app derived server-side) returns people's names and a permission fact (`appAccess`) to
  a service. projects-api then shows them to every `projects:access` holder (AC-4.3, O7: "no access
  to Projects" is visible to project readers).
- **Bookability and assignment** (hours-api, activities-api) widen through the host answer.
- **Admin writes** on a new auth resource must stay `requireAdmin` (no catalog change, O2) and must
  never touch permissions (AC-2.5).

Surfaces for the `owasp-reviewer` pass (in parallel with QE):

1. auth `/admin/teams*` (`src/teams/admin.routes.ts`): gate on every route, no epoch bump, no
   resolver read, the name clash body (`existingName` read from the database; only in the
   rename race is it the caller's own trimmed text, D14), the 405, the row-locked limit.
2. auth `GET /system/teams` (`src/teams/system.routes.ts`): verify-then-count (the allowance
   chosen only by which parameter is present), the identical 401, the `TEAM_READERS` binding,
   `appAccess` derived from the `sub`, ids cap, no-store, and logs with no id, name or `q` text.
   The `q` of the options mode (D13) matches **team names only**. It never matches member names,
   archived teams or descriptions, and it returns `{id, name}` only, which the unfiltered options
   mode already lists. It therefore reveals nothing new: a search over people would be an oracle,
   and it does not exist. `q` is bounded (≤ 80 trimmed, no NUL) and used only as a bound parameter
   of `strpos(lower(…), lower($q))`. `holdersOfAppAccess` and the search use parameterised SQL only.
3. projects-api `src/lib/teams.ts`: send-stamp, no serve after 60 s, single flight, redirect
   refused, body cap, token handling as `serviceToken.ts`.
4. projects-api `GET /projects/{id}` (team member names and access bits), `GET /attached-teams`
   (team names to readers), `GET /attachable-teams` (active team names to managers, `q`
   validated before any auth call, the per-caller limit counted after the guard, `q` never
   logged, D13),
   `PUT /projects/{id}/teams` (`project:manage` + entity + `If-Match`; one fresh read of the new set before
   the write). The D15 windows on the fresh team read:
   - they are keyed by the verified `sub`, never by a header or the body;
   - they are checked after the guards and the row lookup and before any auth call;
   - only admitted reads are recorded, and the 2 400 service window keeps 600 of auth's allowance for
     decisions;
   - a view that was not admitted reads and serves nothing about teams (no cache), so its only
     signal is the caller's own count, and `teamsRetryAfterSeconds` / `retryAfterSeconds` reveal only
     the caller's own window;
   - the refusal log holds the actor id only.
5. projects-api `/activity-host/v1/resolve` and `/meeting-host/v1/resolve`: a non-reader triggers
   no team read and learns nothing; "unknown" is never answered as listed-only or as `false`. They
   never consult the D15 windows, so a person's page limit cannot become a decision refused for
   them or anyone else (AC-5.6).
6. activities-api `assertAssignable` and hours-api `assertOnProject` on `null`.

Because surface 5 widens access to recorded-conversation content (AGENTS.md § Data residency calls
Meetings "the most sensitive content in the suite"), **escalate the review of surfaces 2 and 5 to
the frontier tier**. The rest can run at the standard tier.

## Delivery — two steps, ordered (spec § Delivery, O16)

### Step 1 — Admin (US-1 to US-3)

1. **auth**: migration `20261126100000_teams` (additive), `src/teams/admin.routes.ts`,
   `src/teams/repo.ts`, OpenAPI, tests. Deploy. The routes exist with no consumer.
2. **admin-ui**: the Teams section, strings, gating. Deploy after auth. An earlier admin-ui would
   show an error state, so it is never deployed first.
3. e2e `admin-teams.spec.ts`, plus `helpers/teamsFixtures.ts` (create through the admin API,
   clean up by direct DB delete of rows tagged by run id; allowed by D8).
4. Changesets: `@operai/auth` minor, `@operai/admin-ui` minor.
5. Docs: AGENTS.md (Admin row "… departments, **teams**, users …", the `auth/` comment, Domain
   language § Teams pointing to the glossary).

The step is accepted on its own (spec: "ships a managed list of teams with no consumer yet").

### Step 2 — Projects (US-4, US-5)

Deploy order (each push is safe on its own):

1. **activities-api** and **hours-api**: accept `assignees: null` as unavailable (D3). They are
   harmless before projects-api sends it. Changesets: patch each.
2. **auth**: `teams:read` in `KNOWN_SERVICE_SCOPES` and `DOCUMENTED_CLIENT_SCOPES`, the `teams`
   and `teamsOptions` allowances, `holdersOfAppAccess`, `GET /system/teams` (both modes, `q`
   included). Deploy. Changeset: minor.
3. **A person** adds `teams:read` to the `projects-api` entry of auth's `SERVICE_CLIENTS`
   (production variable), **only after step 2.2's auth is live**: an auth that does not know the
   scope refuses to start (ADR 20261108-crm-pushes-deal-links-to-estimai, the same rule). Same
   commit: `tools/env-doctor/manifest.ts` (projects-api `requiredScopes` + `teams:read`),
   `templates/production/auth.env`, `check.test.ts`, `auth/.env.example`, `infra/README.md` (a
   step in the Projects runbook). No new environment variable anywhere.
4. **projects-api**: migration `20261126120000_attached_team` (additive), `src/lib/teams.ts`,
   `onProject.ts`, `teams.routes.ts` (with `q`, and the PUT's one read of the new set),
   `rateLimiter.ts` (the D13 limiter and the two D15 windows), view (`teamsStatus`,
   `teamsRetryAfterSeconds`), list filter, hosts, matrix. Since 2026-11-27 (D16), also the
   host-path wait in `teams.ts` and meetings-api's `export` of `RESOLVE_TIMEOUT_MS`, which is
   code-only and safe in any order.
   Deploy. projects-api never sends `q` to an auth without it, because step 2.2 comes first. Before step 3 every
   team read is a 401, so attaching answers 503 `teams_unavailable`. No project has a team yet, so
   nothing else changes. Changeset: minor.
5. **projects-ui**: Team card (with the `teamsStatus` banner), `TeamsDialog` (with the save 429),
   `onProject` users, list filter. Deploy after projects-api. `teamsStatus` ships in the same
   projects-api release as `teams` and `onProject`, so no skew is added (R6). Changeset: minor.
6. e2e `projects-teams.spec.ts`:
   - an admin makes a team of a person with Projects access and a person without;
   - a PM attaches it;
   - the card shows both, with the badge on the one without access;
   - the team-only person records hours and is given a task;
   - they are removed from the team, and within the poll their new entry is refused;
   - the filter lists the project;
   - a dedicated persona over the page limit sees the banner and the markers, while the admin's page
     and a team-only person's hours entry are unaffected (AC-5.6).
7. Docs: AGENTS.md (the Projects row: "… team (people and teams) …", the projects-api line on
   `assignees`, the service-client glossary entry `teams:read`).

## Decisions taken in this plan (owner to confirm at the plan gate)

- D2: 30 s fresh / 60 s on refresh failure, per team, send-stamped (the 20261117 consumer rule);
  the project page reads fresh.
- D3: `assignees: null` from the activity host; 503 from the meeting host.
- D5: `baseVersion` in the body, not `If-Match`.
- D6: membership changes take no precondition and are idempotent.
- D7 / AC-2.4: the 100 limit counts deactivated members.
- D11: two allowances per 10 min, `teams` 3 000 (ids) and `teamsOptions` 1 500 (options), amended
  2026-11-26.
- D12: the admin list is filtered in the browser.
- D13 (principle decided by the user on 2026-11-26; figures to confirm): server `q` on
  `GET /attachable-teams`, capped at 50, exact match first; 120 per caller per 10 min.
- D14 (decided by the user on 2026-11-26): `existingName` in the 409 `team_name_taken`.
- D16 (amendment 2026-11-27, eval fix round 2; figures to confirm): a `cached()` team read waits at
  most 800 ms (`TEAMS_HOST_WAIT_MS`), counted once per call. A flight still running then is a failed
  refresh for that call and is not aborted: it keeps its 5 s (`TEAMS_TIMEOUT_MS`) and its answer
  fills the cache. 800 + 1 000 ms margin < the 2 s of activities-api, meetings-api and hours-api,
  pinned by a cross-package test. The page path keeps 5 s. Cache rule unchanged.
- D15 (principle decided by the user with AC-5.6 on 2026-11-26; figures to confirm): the page's
  fresh team read is admitted per person, 120 per `sub` per 10 min, and in total, 2 400 per 10 min.
  Only admitted reads are recorded. When a read is not admitted, the page loads with every team
  marked and `teamsStatus` set to `"rate_limited"` (with `teamsRetryAfterSeconds`) or
  `"unavailable"`, and no cache entry is served. `PUT …/teams` adding a team refuses with 429 or
  503. The decisions are never limited per person.

## Spec ambiguities resolved (no amendment needed; owner to confirm)

- **AC-1.8** reads as "a stale *form*": the team's own fields and its state. Membership changes are
  set operations (D6).
- **AC-3.3**: the Teams screens are bilingual. Audit *summaries* stay the server-written text every
  audit row has today (`strings/audit.ts` renders them as written). The audit page description
  gains "teams" in both languages.
- **AC-3.1** "a direct address redirects away": in admin-ui a legal-entity manager is redirected
  to `/legal-entities`. Someone with no Admin capability never reaches admin-ui, because the
  shell's `/admin` gate turns them away first.
- **AC-4.8**: archived teams that are still attached are offered in the filter, marked "Archived".
- **AC-4.1** "up to 10": over 10 is refused by schema validation (400), with the dialog naming the
  limit before that.

## Spec amendment proposed (drift)

Accepted by the user on 2026-11-26 (spec § Amendments); kept here for the record. AC-5.6 (R11)
was added by the user the same day, and the plan implements it as D15.

- **AC-5.4, second sentence**, "when the project page cannot read them, it still loads, **shows
  the team names** and marks their members 'could not be loaded'". Team names live only in auth
  (AC-1.3: "projects keep no copy of the name"). When the team read fails, the names fail with the
  members, beyond the ≤ 60 s fallback. Showing them anyway would need a stored or long-lived copy,
  which AC-1.3 forbids. Proposed wording: "…it still loads, **shows each attached team** — by name
  when the name could be read, otherwise marked 'could not be loaded' — and marks their members
  'could not be loaded'." The plan implements that wording (D9). The spec is not edited here.

## ADR candidates

For the `adr-writer`; none is written here. Today is 2026-11-26.

- **A1 — Teams live in auth, grant nothing, and a consumer reads their members and each member's
  app access from auth as itself.** Path:
  `docs/adr/20261126-teams-live-in-auth-grant-nothing-and-their-members-and-app-access-are-read-from-auth-by-the-consumer-as-itself.md`.
  - The decision:
    - `team` / `team_member` in auth, `requireAdmin`, never read by the resolver (no epoch bump);
    - `GET /system/teams` with scope `teams:read`, a `sub` → app binding (`system:projects-api` →
      `projects`), `appAccess` computed by auth for the bound app (never named by the caller) and
      proven equal to app-access-check's predicate;
    - consumers cache per team, send-stamped, 30 s fresh / 60 s on failure;
    - a team is a relationship the host states, so meetings-api's "visibility by relationship"
      stands while its readers widen (O8).
  - **Rejected:** teams in projects-api (Admin's API is auth's; a future team permission would sit
    in a tool); departments with a flag (they confer roles); a forwarded-user-JWT `/authz/teams`
    route (per-caller limits, one-id app-access-check, a gate naming a tool permission); a snapshot
    of members at attach (O6); auth pushing changes (a replicated copy).
  - Constrains: any future team consumer, any future team permission, and the next auth-hosted
    fact a service reads together with a permission bit.
  - **To amend (2026-11-26):** the file already exists and predates D13 and D15. This is for the
    `adr-writer`; the plan does not edit ADRs. The file needs:
    1. **Status line:** decisions D1, D2, D8, D10, D11, D13 and D15, and spec AC-5.6 (re-approved by
       the user on 2026-11-26, 31 ACs).
    2. **Point 2:** name the two modes of `GET /system/teams`: ids (1..50 ids) and options
       (`state=active`). The options mode takes an optional `q`:
       - it matches team names only, never members, descriptions or archived teams;
       - it is bounded: no NUL, at most 200 characters raw, 1..80 after trimming;
       - it matches literally, `strpos(lower(name), lower(q)) > 0`, never `LIKE`, so `%`, `_` and `\`
         are characters;
       - it answers at most 50, with `truncated`, ranked exact match, then prefix, then the rest. Every
         active team is therefore reachable by its whole name, whatever the cap;
       - it reveals nothing that the unfiltered options list does not.
    3. **Point 6:** two allowances per calling service per 10 min, chosen by which parameter is
       present and counted after verification: `teams` 3 000 (`TEAMS_SERVICE_LIMIT`, the ids mode,
       for the decisions and the project page) and `teamsOptions` 1 500
       (`TEAMS_OPTIONS_SERVICE_LIMIT`, the options mode, for the attach search). The reason: a read
       whose volume a person drives must not spend the budget a decision depends on. projects-api
       also limits `GET /attachable-teams` to 120 per caller per 10 min.
    4. **A new point after 6: the consumer limits the person-driven read on the decisions'
       allowance.** Two in-process windows of 10 min admit the project page's fresh ids read:
       - 120 per verified `sub`, counted after the access check and the row lookup and before the
         auth call, only for a project with an attached team, with only admitted reads recorded;
       - 2 400 for all people together, which keeps 600 of the 3 000 for the cached decision path.

       The decisions (activity-host, meeting-host) never consult these windows. A read that is not
       admitted makes no call and serves no cached entry, and the page still loads. Every team and
       its members are marked "could not be loaded", with `teamsStatus: "rate_limited"` and
       `teamsRetryAfterSeconds` for the person's window, or `"unavailable"` for the service's. A
       write that must confirm (`PUT …/teams` adding a team) refuses with 429 `rate_limited` or 503.
    5. **Point 5:** "The project page reads fresh" gains "within the limits of the new point. Over
       them it reads nothing and serves no cached entry (AC-5.6), and the next admitted load still
       shows a rename (AC-1.3)".
    6. **Failure shape:** add a mirror bullet. A budget a decision depends on, shared with a read a
       person drives (a page, a search), is spent by whoever reads most. The person-driven read is
       limited per person and in total, below the shared budget, and the decision path is not
       limited per person. ADR 20261112-push-liveness-answer-reused-30-seconds names the same shape.
    7. **Risks:** restate "Allowance exhausted (D11)" with the reserve: page reads ≤ 2 400, the cached
       path about 40 per 10 min per 50 attached teams. Add "every limit is per process" (R12).
    8. **Escalation triggers:**
       - a second projects-api replica: divide the figures, or move them to a shared store;
       - the person's or the service's window reached in normal use, which the refusal log line
         shows;
       - more than about 750 teams attached to projects, where the cached path's worst case
         approaches the 600 reserve.
    9. **Consequences, negative:** a person over their page limit sees the teams marked, not loaded,
       until their oldest read leaves the window, and is not offered Record hours on the page
       through a team in the meantime (hours-api still decides).
    10. **Relates to:** add ADR 20261112-push-liveness-answer-reused-30-seconds (a per-event check on
        a budget shared with other callers).
    11. **Evidence:** the D15 tests (the AC-5.6 row and *Further tests*) and the two-allowance tests.

    D14 is a contract detail with no ADR of its own. D15's rejected alternatives stay in the plan;
    they are not options of A1, which decides where teams live and how they are read.
- **A2 — A host says "unknown" for the one field a decision needs, instead of failing the reads that
  do not need it.** Path:
  `docs/adr/20261126-a-host-says-unknown-for-the-one-field-a-decision-needs-instead-of-failing-the-reads-that-do-not-need-it.md`.
  - Amends ADR 20261110-activities-service-access-delegated-to-host: a listing host may answer
    `assignees: null`, and consumers refuse only the decision that reads it (503
    `host_unavailable`), never treat it as nobody, and never parse it as a list.
  - **Rejected:** 503 for the whole batch (one project's team read hides up to 24 other projects'
    tasks); answering the listed members alone (AC-5.4: "never answered from the individual members
    alone").
  - Where the contract cannot express "unknown" (meeting host `hostVisible`, where absent means
    false), the host answers 503.
  - Constrains every future host field that depends on a third service.
  - **To amend (2026-11-27, D16):** this is for the `adr-writer`; the plan does not edit ADRs. The
    Risks bullet at line 109, "A team read that is slow rather than failed. The 2 s host timeout
    still makes the whole call unavailable (unchanged); …", now reads false. Replace it with:

    > **A team read that is slow rather than failed.** *Amended 2026-11-27 (plan D16):* the host
    > path waits at most `TEAMS_HOST_WAIT_MS` (800 ms) for a team read, and 800 ms plus a 1 s
    > margin stays strictly inside the 2 s resolve deadline of activities-api, meetings-api and
    > hours-api (ADR 20261119-on-demand-outbound-work-…; a cross-package test relates the
    > constants). A read still running at the wait counts as failed for that call: an entry of at
    > most 60 s is used, else `assignees: null` (meeting host: 503 `teams_unavailable`), for
    > projects with attached teams only. The read itself is not aborted, and its answer fills the
    > cache for the next call. Only a resolve slowed by something other than the team read (a cold
    > permission check against a slow auth) can still make the whole call unavailable.

    Evidence gains the D16 tests (`teams.budgets.cross-package.test.ts`,
    `teams.hostWait.test.ts`). Relates to gains ADR 20261119-on-demand-outbound-work-…. ADR
    20261119 itself needs no amendment: D16 is a further case of its rule.
- **A3 (lower weight) — Stale-write refusal in auth's admin API is a body `baseVersion` + 409
  `version_conflict` + `currentVersion`, not `If-Match`.** Path:
  `docs/adr/20261126-auth-admin-writes-carry-their-base-version-in-the-body-because-auth-cors-exposes-no-etag.md`.
  - Generalises the legal-entity registry's choice to every mutable admin row in auth.
  - **Rejected:** widening auth's CORS (`allowHeaders` `If-Match`, `exposeHeaders` `ETag`) for one
    feature, on the identity service.
  - Constrains future admin resources in auth (roles and departments today have no precondition at
    all).

## Glossary candidates

(`.claude/context/glossary.md` § Teams; not edited here.)

- **Attached team**: a team put on a project by a project manager. Its active members with
  Projects access are on the project, it stays attached when archived, and it is removed only by
  detaching. The spec and the plan use the term; the glossary lacks it. The code name is
  `project_attached_team` / `AttachedTeam`.
- **Counted member** (optional): an active member of an attached team who holds Projects access,
  the part of a team that is on the project (AC-4.4, AC-4.7). The plan's code name is
  `countedMembers`. If the glossary prefers not to add the term, the code keeps it only as a
  function name.
- Naming check: the glossary says to avoid "assigned" for *on the project*. The existing wire field
  `assignees` (activity host) is kept because it is an existing contract. The new view field uses
  the glossary's word, `onProject`.

## Self-critique (one pass, plan.md checklist)

- **AC→test gap:** all 30 mapped. The pass added AC-1.3 and found that a 30 s cache would break the
  literal "next load" (fixed by the fresh page read, D2). It added AC-4.9's API test (a team id as
  PM). Kept: AC-4.6 is proven by a unit proof plus one polled e2e, not a test-only TTL switch.
- **Prose contracts:** every new route has a request and response shape and its refusals.
  `GET /system/teams` has a sample body for both modes.
- **Idealized codebase:** checked against code. auth's CORS forbids `If-Match` (forced D5).
  projects-ui holds two copies of the rule (now read from `onProject`). activities-api and hours-api
  reject a `null` list (made D3 order-safe). There is no `not_deletable` in code today (cited as
  the ADR's posture, not as code).
- **Security NO reflex:** answered YES, with surfaces and a frontier-tier escalation for the
  meeting-reader widening.
- **Amendment pass (2026-11-26, D13, D14):** re-checked the 30 ACs. AC-1.2, AC-1.5, AC-1.6, AC-3.3
  and AC-4.1 gained tests, and no AC lost one. The pass made three fixes:
  - the pre-check and the re-read use `lower() =` and not `ILIKE`, which would turn `_` into a
    wildcard and report a false clash;
  - the ranking puts the exact match first, so a capped search is a proof of reach and not a hope;
  - the options mode gets its own allowance, so a typed search cannot starve decisions.

  Kept and reported as open: the fresh page read on the decisions' allowance (R11).
- **Amendment pass (2026-11-26, D15, AC-5.6):** re-checked the 31 ACs. AC-5.6 is mapped to its three
  observable parts: the limited person's page, another person's page, and the decisions. AC-5.4
  gained the `teamsStatus` assertions, and no AC lost a test. The pass made four fixes:
  - It cut the `PUT …/teams` path from up to two auth calls (added ids, then the view) to one.
    Without that, the "one request, one count" rule and the 2 400 proof did not hold.
  - It decided that a refusal by the service window says `"unavailable"`, not `"rate_limited"`.
    Saying the person made too many requests when others did would be false, and the AC-5.4
    rendering already covers "cannot read them".
  - It put the 429 retry time in the body, because projects-api's CORS exposes only `ETag`. A
    `Retry-After` the browser cannot read is no help.
  - It made a pure-detach `PUT …/teams` go on when auth fails or the read is not admitted, so that
    reading the whole set does not turn a write that needs no confirmation into a refusal.

  Kept: the service window, beyond what AC-5.6 asks for one person, because it is what makes R11
  closed and not "closed for one person". Its figures are the owner's to confirm.
- **Amendment pass (2026-11-27, D16, deadline nesting):** re-checked the 31 ACs. No AC changes
  or loses a test. AC-4.6 and AC-5.4 gained the slow-auth cases, and the AC-4.6 proof holds,
  because a late answer keeps its own send stamp. The pass made three fixes:
  - The wait is counted per `cached()` call and not per chunk. Per chunk, 250 team ids (5 chunks)
    could wait 5 × 800 ms.
  - The flight is not aborted at the wait. Aborting it would renew no entry while auth is slow
    but up.
  - It added a static check that the host routes use only `cached()`. The constant test alone
    would stay green if a host route moved to `fresh()`.

  Kept, and named as R13 rather than fixed: the cold permission resolve (5 s) and the hours-api →
  activities-api chain. Neither is a team read, so both are outside this feature.
