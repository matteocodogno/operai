---
spec: 20261126
generated: 2026-11-26
synced: 2026-11-27
---

# Tasks: Teams — named groups of people, managed in Admin, taking part in projects

Contract: `plan.md` (approved 2026-11-26, amended D13/D14/D15) and `design.md`. Every backend test
runs against the `*_test` database, never the dev one. Each task ships its own Changeset (file names
given, so no two tasks collide on `.changeset/`).

## Step 1 — Admin (US-1 to US-3)

- [x] T1: [backend] auth — `team` / `team_member` schema and migration, shared repo reads — refs: AC-1.1, AC-1.2, AC-1.7, AC-2.3, AC-2.5 — deps: none
  - touch: `auth/prisma/schema.prisma`, `auth/prisma/migrations/20261126100000_teams/*`, `auth/src/teams/repo.ts`, `auth/src/teams/repo.test.ts`, `auth/src/lib/generated/prisma/*`
  - done when: the migration applies on `operai_auth_test` at its predecessor; a raw-SQL insert of a `lower()`-clashing name raises a unique violation; the shape CHECKs refuse an untrimmed / 81-char name and a 501-char description; `team_member.teamId` is `ON DELETE RESTRICT`; `bun run typecheck` and `bun test src/teams` green
- [x] T2: [backend] auth — `/admin/teams*` team routes: list, create, detail, PATCH with `baseVersion`, archive, restore, DELETE → 405, name clash with `existingName`, audit without epoch bump — refs: AC-1.1, AC-1.2, AC-1.4, AC-1.5, AC-1.6, AC-1.7, AC-1.8, AC-2.5, AC-3.1, AC-3.2 — deps: T1
  - touch: `auth/src/teams/admin.routes.ts`, `auth/src/teams/admin.routes.test.ts`, `auth/src/teams/nameTaken.ts`, `auth/src/teams/nameTaken.test.ts`, `auth/src/index.ts`, `auth/src/openapi/*`, `auth/src/authz/resolver.static.test.ts`, `.changeset/teams-auth-admin.md`
  - done when: the plan's Test strategy rows AC-1.1, 1.2 (deep-equal 409 body, stored casing, wildcard and race cases, OpenAPI requires `existingName`), 1.4, 1.5/1.6 (admin side), 1.7, 1.8 (stale `baseVersion`, parallel PATCH), 2.5 (resolver before = after, epoch unchanged, static test that `resolver.ts` names neither `team` nor `teamMember`), 3.1 (401/403/200 on every route, department-conferred admin refused, catalog unchanged) and 3.2 (one audit row per change, none per refusal or no-op) pass in `auth/src/teams/admin.routes.test.ts`
- [x] T3: [backend] auth — team member routes: add (active users only, row-locked limit 100 incl. deactivated), remove, idempotent no-ops, audit rows naming the person — refs: AC-2.1, AC-2.2, AC-2.3, AC-2.4, AC-2.5, AC-3.2 — deps: T2
  - touch: `auth/src/teams/admin.routes.ts`, `auth/src/teams/members.test.ts`, `auth/src/teams/repo.ts`
  - done when: the AC-2.1–2.4 rows pass (a person in two teams; 422 `user_not_active` one body for unknown and soft-deleted; soft-deleted member listed `deactivated:true`, not counted, counted again after `deletedAt` is cleared; 100 → 422 `team_full {limit:100}`; two concurrent adds at 99 → one 200 and one 422; add to an archived team → 200); AC-2.5 and AC-3.2 assertions cover the member writes
- [x] T4: [frontend] admin-ui — Teams list: `adminApi` team client, `strings/teams.ts` (en + it), router `/teams`, `ADMIN_SEGMENTS` + `SectionNav` tab, `TeamsPage` (search, Active/Archived/All), `TeamFormDialog` (create; 409 `existingName` message) — refs: AC-1.1, AC-1.2, AC-1.4, AC-3.1, AC-3.3 — deps: T2
  - touch: `admin-ui/src/lib/adminApi.ts`, `admin-ui/src/lib/adminApi.test.ts`, `admin-ui/src/strings/teams.ts`, `admin-ui/src/strings/nav.ts`, `admin-ui/src/strings/audit.ts`, `admin-ui/src/strings.ts`, `admin-ui/src/router.tsx`, `admin-ui/src/router.test.tsx`, `admin-ui/src/components/AdminShell.tsx`, `admin-ui/src/components/SectionNav.tsx`, `admin-ui/src/components/SectionNav.test.tsx`, `admin-ui/src/pages/TeamsPage.tsx`, `admin-ui/src/pages/TeamsPage.test.tsx`, `admin-ui/src/components/TeamFormDialog.tsx`, `admin-ui/src/components/TeamFormDialog.test.tsx`, `admin-ui/src/components/TeamStatusBadge.tsx`, `.changeset/teams-admin-ui.md`
  - done when: `TeamsPage.test.tsx` (default active only, Archived/All, case-insensitive substring search, create → row, no delete control), `TeamFormDialog.test.tsx` (the name-clash message names `existingName` in en and it, never shows `detail`, generic failure without `existingName`), `SectionNav.test.tsx` and the router test (no Teams tab without `admin:access`; `/teams` redirects a legal-entity manager to `/legal-entities`) pass; `catalogGaps` parity and `noHardcodedStrings` green; no `form form` in any dialog state; `pnpm lint && pnpm build && pnpm test` green
- [x] T5: [frontend] admin-ui — Team detail: edit (`baseVersion`, stale banner keeps typed values), archive / restore (`ConfirmDialog`), members (name, email, Deactivated badge, `formatDate` added date), add via `SearchPicker` over `listUsers`, remove with confirmation — refs: AC-1.5, AC-1.6, AC-1.7, AC-1.8, AC-2.1, AC-2.2, AC-2.3, AC-2.4, AC-3.3 — deps: T4, T3
  - touch: `admin-ui/src/pages/TeamDetail.tsx`, `admin-ui/src/pages/TeamDetail.test.tsx`, `admin-ui/src/lib/adminApi.ts`, `admin-ui/src/strings/teams.ts`, `admin-ui/src/router.tsx`
  - done when: `TeamDetail.test.tsx` covers edit, stale 409 → banner with typed values kept, archive / restore, add member (a pick alone never writes), remove with confirmation, 422 `team_full` and `user_not_active` messages, Deactivated badge, dd.mm.yyyy date in it and en, no delete control, no nested form; parity, hardcoded-copy, lint, build and tests green
- [x] T6: [frontend] shell e2e — `admin-teams.spec.ts` and `helpers/teamsFixtures.ts` (create through the admin API, clean up by run-id tagged direct DB delete) — refs: AC-1.1, AC-2.1, AC-3.1 — deps: T3, T5
  - touch: `shell/e2e/admin-teams.spec.ts`, `shell/e2e/helpers/teamsFixtures.ts`
  - done when: `cd shell && pnpm e2e admin-teams.spec.ts` passes against the running stack: an admin creates a team, adds a member, archives and restores it; a non-admin sees no Teams entry and a direct `/admin/teams` address does not show the screen

## Step 2 — Projects (US-4, US-5)

- [x] T7: [backend] activities-api — accept `assignees: null` from a listing host as "unavailable"; refuse an assignment on it with 503 `host_unavailable`, reads and an unchanged resent assignee unaffected — refs: AC-5.2, AC-5.4 — deps: none
  - touch: `activities-api/src/hosts/client.ts`, `activities-api/src/hosts/registry.ts`, `activities-api/src/activities/activities.routes.ts`, `activities-api/src/hosts/client.test.ts`, `activities-api/src/activities/assignable.test.ts`, `.changeset/teams-activities-null-assignees.md`
  - done when: tests pass for: a stub host whose `assignees` holds a team-only person → task created assigned to them; `assignees: null` → 503 `host_unavailable` on create and reassign, 200 on list; `undefined` from a `host_list` host stays malformed; an unchanged resend is accepted; `bun run typecheck` and `bun test` green
- [x] T8: [backend] hours-api — wire `assignees: string[] | null`; `assertOnProject` refuses `null` with 503 `host_unavailable`, labels still resolve — refs: AC-5.1, AC-5.4 — deps: none
  - touch: `hours-api/src/clients/projects.ts`, `hours-api/src/targets/bookability.ts`, `hours-api/src/targets/bookability.test.ts`, `hours-api/src/clients/projects.test.ts`, `.changeset/teams-hours-null-assignees.md`
  - done when: `bookability.test.ts` passes for a team-only person in `assignees` → accepted, and `null` → 503 `host_unavailable`; `bun run typecheck` and `bun test` green
- [x] T9: [backend] auth — `GET /system/teams` (ids and options modes, `q` search, frozen 401, `TEAM_READERS` binding), `holdersOfAppAccess` with its contract test, scope `teams:read`, allowances `teams` 3 000 and `teamsOptions` 1 500 — refs: AC-1.5, AC-1.6, AC-4.1, AC-4.7 — deps: T3
  - touch: `auth/src/teams/system.routes.ts`, `auth/src/teams/system.routes.test.ts`, `auth/src/authz/resolver.ts`, `auth/src/authz/holdersOfAppAccess.contract.test.ts`, `auth/src/system/serviceClients.ts`, `auth/src/system/serviceClients.test.ts`, `auth/src/system/systemRateLimits.ts`, `auth/src/system/systemRateLimits.test.ts`, `auth/src/system/systemCapacity.contract.test.ts`, `auth/src/index.ts`, `.changeset/teams-auth-system.md`
  - done when: the plan's "auth `GET /system/teams`" further tests pass (identical 401 for every failure incl. a user JWT and a `sub` outside `TEAM_READERS`; verify before count; the two allowances independent; ids ≤ 50, unknown omitted, `no-store`; `q` bounds → 400 with no echo; ranking exact → prefix → rest with the 60-decoy fixture; `%`, `_`, `\` literal; archived excluded; log line has no id, name or `q`); the AC-4.7 contract test shows `holdersOfAppAccess` equals `resolveEffectivePermissions(...).some(...)` for direct, department-conferred, conditioned, none and soft-deleted fixtures; `teams:read` known and pinned in projects-api's documented scopes
- [x] T10: [devops] env contract and runbook for `teams:read` — env-doctor manifest, production auth template, `check.test.ts`, `auth/.env.example`, `infra/README.md` (grant only after the step-2 auth is live) — refs: AC-4.1, AC-4.7 — deps: T9
  - touch: `tools/env-doctor/manifest.ts`, `tools/env-doctor/templates/production/auth.env`, `tools/env-doctor/check.test.ts`, `auth/.env.example`, `infra/README.md`
  - done when: `mise run env:doctor` (production templates) passes and `check.test.ts` pins projects-api's scopes including `teams:read`; the runbook step states the deploy order (auth with the scope live first, then the `SERVICE_CLIENTS` edit, then projects-api); local `.env.example` grants the scope so a dev stack can attach teams
- [x] T11: [backend] projects-api — foundation: migration `project_attached_team`, `src/lib/teams.ts` (auth client, send-stamped 30 s / 60 s cache, single flight, chunks of 50, 401 → one retry), `src/lib/rateLimiter.ts` (copied from auth, `peek`, the D13 limiter and the two D15 windows, `admitTeamRead`), `src/projects/onProject.ts` (pure) — refs: AC-4.4, AC-4.5, AC-4.6, AC-4.7, AC-5.6 — deps: none
  - touch: `projects-api/prisma/schema.prisma`, `projects-api/prisma/migrations/20261126120000_attached_team/*`, `projects-api/src/lib/generated/*`, `projects-api/src/lib/teams.ts`, `projects-api/src/lib/teams.test.ts`, `projects-api/src/lib/rateLimiter.ts`, `projects-api/src/lib/rateLimiter.test.ts`, `projects-api/src/projects/onProject.ts`, `projects-api/src/projects/onProject.test.ts`, `projects-api/src/test-support/world.ts`
  - done when: the migration applies on `projects_test` at `20261124160000` and the table has no name column; `teams.test.ts` (fake clock: used to t + 30 s, refreshed after; failed refresh → used to t + 60 s with `teams_stale_used`, then unavailable; stamp is the send time; single flight; piggyback > 15 s; 401 → token dropped, one retry), `rateLimiter.test.ts` (`peek` records nothing, refused `consume` records nothing, `admitTeamRead` both-or-neither, remainder rounded 1..600, constants 120 / 2 400 / 600 000 ms, distinct from the attach limiter) and `onProject.test.ts` vectors (AC-4.4/4.5/4.7: once each, order, no-access and deactivated excluded, archived team counts, detach) pass; `resetWorld()` resets every window
- [x] T12: [backend] projects-api — the project view (`teams`, `onProject`, `onProjectComplete`, `teamsStatus`, `teamsRetryAfterSeconds`, fresh read through `admitTeamRead`), `PUT /projects/{id}/teams` (one read of the new set, 422 `team_not_found` / `team_archived`, 429 `rate_limited` with `retryAfterSeconds`, 503), `GET /attachable-teams[?q=]` with its per-caller limit, matrix rows — refs: AC-1.3, AC-1.5, AC-4.1, AC-4.2, AC-4.3, AC-4.7, AC-4.9, AC-5.4, AC-5.5, AC-5.6 — deps: T11
  - touch: `projects-api/src/projects/teams.routes.ts`, `projects-api/src/projects/teams.test.ts`, `projects-api/src/projects/teams.pageLimit.test.ts`, `projects-api/src/projects/projects.routes.ts`, `projects-api/src/projects/projects.schemas.ts`, `projects-api/src/projects/projects.schemas.test.ts`, `projects-api/src/index.ts`, `projects-api/src/matrix.test.ts`, `.changeset/teams-projects-api.md`
  - done when: the plan's rows AC-1.3, 1.5 (projects side), 4.1 (PUT, `q` trimming/bounds, `truncated`), 4.2, 4.3, 4.7 (view marks the member), 4.9, 5.4 (view and remove-only PUT with auth failing), 5.5 and the full AC-5.6 row in `teams.pageLimit.test.ts` (121st load: no stub call, no cache entry served, retry time does not move; another person unaffected; writes over the limit; counting position; service window → `"unavailable"`) pass; the four view invariants and the OpenAPI requirements hold; the matrix has rows for the new routes and every 200 carrying a `Project` has `teamsStatus`; `bun test` green
- [x] T13: [backend] projects-api — hosts use `onProject()`: activity-host `assignees` (or `null` when a team's members are unavailable), meeting-host `hostVisible` (503 `teams_unavailable` when unknown, PM and listed members answered without a team read); neither consults the D15 windows — refs: AC-4.4, AC-4.5, AC-5.1, AC-5.2, AC-5.3, AC-5.4, AC-5.6 — deps: T11
  - touch: `projects-api/src/activity-host/activity-host.routes.ts`, `projects-api/src/activity-host/activity-host.test.ts`, `projects-api/src/meeting-host/meeting-host.routes.ts`, `projects-api/src/meeting-host/meeting-host.test.ts`
  - done when: activity-host `assignees` equals the `onProject` vector and is `null` for a project with teams while auth fails (the listed set for one without); meeting-host gives a team-only reader `hostVisible:true`, `false` after removal, `closed` for a member without Projects access, 503 `teams_unavailable` when unknown; a spy shows neither resolve touches the D15 windows; the existing "never cached" tests stay green
- [x] T14: [backend] projects-api — `GET /attached-teams` (distinct attached teams, archived included, unknown names last, cached path) and `GET /projects?teamId=` — refs: AC-4.8 — deps: T12
  - touch: `projects-api/src/projects/teams.routes.ts`, `projects-api/src/projects/attachedTeams.test.ts`, `projects-api/src/projects/projects.routes.ts`, `projects-api/src/projects/projects.schemas.ts`, `projects-api/src/matrix.test.ts`
  - done when: `GET /projects?teamId=` lists only projects with that team; `/attached-teams` lists each team on ≥ 1 project once, archived ones included; matrix row present; `bun test` green
- [x] T15: [frontend] projects-ui — Team card Teams section (badges, "could not be loaded", `teamsStatus` banners, Retry), `TeamsDialog` (server-searched `SearchPicker`, limit 10, stale, 422/503, save 429 inline), "Edit people" label, types and API client — refs: AC-1.3, AC-4.1, AC-4.2, AC-4.3, AC-4.7, AC-5.4, AC-5.6 — deps: T12
  - touch: `projects-ui/src/components/TeamCard.tsx`, `projects-ui/src/components/TeamCard.test.tsx`, `projects-ui/src/components/AttachedTeams.tsx`, `projects-ui/src/components/TeamsDialog.tsx`, `projects-ui/src/components/TeamsDialog.test.tsx`, `projects-ui/src/pages/ProjectDetailPage.tsx`, `projects-ui/src/pages/ProjectDetailPage.test.tsx`, `projects-ui/src/lib/projectsApi.ts`, `projects-ui/src/lib/types.ts`, `projects-ui/src/strings/project.ts`, `.changeset/teams-projects-ui.md`
  - done when: `TeamCard.test.tsx` (People and Teams sections, the three badges, `"unavailable"` → AC-5.4 banner only, `"rate_limited"` → the too-many-requests banner and markers on every team, unknown status → as unavailable, the two banners mutually exclusive, Retry focus rule) and `TeamsDialog.test.tsx` (searches via `GET /attachable-teams?q=`, nothing fetched on open, attached/staged ids left out, > 80 chars → no match without request, `truncated` hint, 503/429 search → unavailable, attach, detach, limit named at 10, 409 → stale, save 429 inline with the dialog open) pass; design G8 checked (Retry does not unmount the card, or the fallback focus is used); parity, hardcoded-copy, no nested form, lint, build, tests green
- [x] T16: [frontend] projects-ui — `TaskFormDialog` and `recordHours` read `project.onProject` (note when incomplete; current assignee stays selectable, design G10), defensive fallback for an older projects-api, `ProjectsPage` Team filter fed by `GET /attached-teams` — refs: AC-4.8, AC-4.9, AC-5.1, AC-5.2, AC-5.4 — deps: T15, T14
  - touch: `projects-ui/src/components/TaskFormDialog.tsx`, `projects-ui/src/components/TaskFormDialog.test.tsx`, `projects-ui/src/components/TasksCard.tsx`, `projects-ui/src/lib/recordHours.ts`, `projects-ui/src/lib/recordHours.test.ts`, `projects-ui/src/pages/ProjectsPage.tsx`, `projects-ui/src/pages/ProjectsPage.test.tsx`, `projects-ui/src/lib/projectsApi.ts`, `projects-ui/src/lib/types.ts`, `projects-ui/src/strings/project.ts`, `projects-ui/src/strings/projects.ts`
  - done when: `TaskFormDialog.test.tsx` offers `onProject` (non-deleted), shows the incomplete note and keeps the current assignee selectable when teams are not loaded; `mayRecordOnProject` uses `onProject`; the fallback `onProject ?? [PM, ...team]` is test-pinned; `ProjectsPage.test.tsx` filters by team (archived attached teams marked); the PM picker offers only people (AC-4.9); lint, build, tests green
- [x] T17: [frontend] shell e2e — `projects-teams.spec.ts`: a team of a person with and one without Projects access, attached by a PM, card badges, the team-only person records hours and is given a task, removal refused within a 65 s poll, the list filter, a dedicated over-limit persona sees the banner while others are unaffected — refs: AC-1.3, AC-4.1, AC-4.3, AC-4.6, AC-5.1, AC-5.2, AC-5.6 — deps: T6, T7, T8, T10, T13, T16
  - touch: `shell/e2e/projects-teams.spec.ts`, `shell/e2e/helpers/teamsFixtures.ts`
  - done when: `cd shell && pnpm e2e projects-teams.spec.ts` passes against the running stack (needs hours-api, activities-api and auth with `teams:read` granted to projects-api locally)

## Close

- [x] T18: [devops] docs and close — AGENTS.md (Admin and Projects rows, `auth/` and projects-api lines, the `teams:read` service-client entry, Domain language § Teams pointing to the glossary); every touched app's lint, typecheck, build and tests green; spec status → done via `/wellforge:done` — refs: AC-3.1, AC-4.3 — deps: T17
  - touch: `AGENTS.md`
  - done when: the AGENTS.md lines name teams where the plan's Delivery lists them; each touched app's gates are green (auth, admin-ui, activities-api, hours-api, projects-api, projects-ui, env-doctor); `/wellforge:done 20261126-teams` passes its gate

## Fix rounds (after the 18 tasks)

Re-synced 2026-11-27 against the plan amendments made during verification. No new task: each amendment was implemented as a fix round and verified by QE (see `qe-report.md` and `decisions.md`).
- QE D1 (plan § API contracts "No NUL in ids and team text"): fix 05d2981b, ed8e160b — QE round 1 PASS.
- Eval round 1 (plan D16, the host path waits at most 800 ms for a team read; Italian register): fix 242c700b, 2ea04944 — QE round 2 PASS.

- After the close (2026-11-27): R12 and R13 fixed as a follow-up per `r12-r13-decision.md`; R14 recorded in plan § Risks. No AC of this feature changes.

## Coverage

| AC | Tasks |
|---|---|
| AC-1.1 | T1, T2, T4, T6 |
| AC-1.2 | T1, T2, T4 |
| AC-1.3 | T12, T15, T17 |
| AC-1.4 | T2, T4 |
| AC-1.5 | T2, T5, T9, T12 |
| AC-1.6 | T2, T5, T9 |
| AC-1.7 | T1, T2, T5 |
| AC-1.8 | T2, T5 |
| AC-2.1 | T3, T5, T6 |
| AC-2.2 | T3, T5 |
| AC-2.3 | T1, T3, T5 |
| AC-2.4 | T3, T5 |
| AC-2.5 | T1, T2, T3 |
| AC-3.1 | T2, T4, T6, T18 |
| AC-3.2 | T2, T3 |
| AC-3.3 | T4, T5 |
| AC-4.1 | T9, T10, T12, T15, T17 |
| AC-4.2 | T12, T15 |
| AC-4.3 | T12, T15, T17, T18 |
| AC-4.4 | T11, T13 |
| AC-4.5 | T11, T13 |
| AC-4.6 | T11, T17 |
| AC-4.7 | T9, T10, T11, T12, T15 |
| AC-4.8 | T14, T16 |
| AC-4.9 | T12, T16 |
| AC-5.1 | T8, T13, T16, T17 |
| AC-5.2 | T7, T13, T16, T17 |
| AC-5.3 | T13 |
| AC-5.4 | T7, T8, T12, T13, T15, T16 |
| AC-5.5 | T12 |
| AC-5.6 | T11, T12, T13, T15, T17 |

## Overlaps resolved

- `auth/src/teams/admin.routes.ts`, `repo.ts`: T2, T3 → declared T3 deps T2. T1 ↔ T3 on `repo.ts` is ordered through T2.
- `auth/src/index.ts`: T2, T9 → ordered (T9 deps T3 deps T2).
- `admin-ui/src/lib/adminApi.ts`, `strings/teams.ts`, `router.tsx`: T4, T5 → declared T5 deps T4.
- `projects-api/src/test-support/world.ts`: only T11 edits it (it provides the team stub and helpers), so T12 and T13 stay parallel.
- `projects-api/src/projects/teams.routes.ts`, `projects.routes.ts`, `projects.schemas.ts`, `matrix.test.ts`: T12, T14 → declared T14 deps T12.
- `projects-ui/src/lib/projectsApi.ts`, `types.ts`, `strings/project.ts`: T15, T16 → declared T16 deps T15.
- `shell/e2e/helpers/teamsFixtures.ts`: T6, T17 → declared T17 deps T6.
- `.changeset/`: every task names its own file, so there is no overlap.
- No overlap left between T7, T8, T11 (all `deps: none`), nor between T12 and T13 (both after T11): they may run in parallel.
