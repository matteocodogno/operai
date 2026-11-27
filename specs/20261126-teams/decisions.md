# Decisions — Teams

Choices the agents made that the spec, plan and tasks did not dictate. Disagree with one?
It is drift: amend the spec/plan and re-sync tasks — do not quietly edit the code.

## T1 · backend-dev · 2026-11-26
- default: the name CHECK is plan.md's `char_length(name) BETWEEN 1 AND 80 AND name = btrim(name)`, which trims spaces only, not tabs or newlines — why: plan.md specifies it, and the API's JS `trim()` already removes those characters, so the DB stays looser than the API — where: `auth/prisma/migrations/20261126100000_teams/migration.sql`
- scope: `src/teams/repo.ts` exports `listTeamSummaries` (all teams, archived included, name order) and `getTeamDetail`, with exported types `TeamSummary`, `TeamMemberAdmin` and `TeamDetail` taken from plan § auth admin routes — why: T1's "shared repo reads" are the list and the detail, and T2/T3 reuse them — where: `auth/src/teams/repo.ts`
- assumption: sort order uses `Intl.Collator("it", {sensitivity:"base"})`, as `directory.routes.ts` does, with stored casing then id as tie-breakers — why: plan says "name order (collator)" without naming a locale, and this matches the existing convention — where: `auth/src/teams/repo.ts`
- assumption: the repo test reuses `inRolledBackTx` and `attempt` from `auth/src/legalEntities/testDb.ts` instead of a new helper — why: they are generic and avoid a second copy, but this couples the teams tests to that module — where: `auth/src/teams/repo.test.ts`

## T7 · backend-dev · 2026-11-26
- assumption: the internal marker for "unavailable" is the string literal `"unavailable"` in `HostEntity.assignees` — why: plan.md says `null` is internal `"unavailable"`, and `null` is already used for "host does not list assignees" — where: `activities-api/src/hosts/registry.ts`, `activities-api/src/hosts/client.ts`
- scope: a task create or reassign that names yourself as assignee is also refused 503 on `null` — why: ADR "unknown is not nobody"; naming yourself is checked like any other assignee on a `host_list` host today — where: `activities-api/src/activities/activities.routes.ts`
- scope: `test-support/hosts.ts` is left unedited, and the `null` answers are scripted through `mode.body` — why: the file is outside T7's `touch:` list — where: `activities-api/src/activities/assignable.test.ts`

## T8 · backend-dev · 2026-11-26
- assumption: `null` is allowed only on an `open` item; an absent `assignees` stays malformed (and so `unavailable`) — why: the plan says `undefined` stays malformed and only `null` means "unknown" — where: `hours-api/src/clients/projects.ts`
- scope: the `null` answer was scripted through the existing `hosts.fail(..., {body})` hook instead of extending `hosts.setProject` to accept `null` — why: `src/test-support/hosts.ts` is outside T8's `touch:` list — where: `hours-api/src/clients/projects.test.ts`, `hours-api/src/targets/bookability.test.ts`
- default: the changeset is a `patch` for `@operai/hours-api` only — why: the task names a single patch changeset and the change is internal consumer tolerance — where: `.changeset/teams-hours-null-assignees.md`

## T2 · backend-dev · 2026-11-26
- default: a stale `baseVersion` on an otherwise unchanged PATCH, or an already-archived or already-active archive/restore, is still 409 (the version check comes first); only a current-version no-op is a 200 with no bump — why: a stale form must hear it is stale — where: `auth/src/teams/admin.routes.ts`
- default: `DELETE /admin/teams/{id}` answers 405 for every id, existing or not — why: no existence signal, same answer for all — where: `auth/src/teams/admin.routes.ts`
- default: team body validation failures use `application/problem+json` with `code: validation_failed` and issue paths/messages, never submitted values; the 409 and 404 bodies also use `application/problem+json` (departments use `application/json`) — why: the plan's name-clash body specifies `problem+json` — where: `auth/src/teams/admin.routes.ts`
- default: a unique violation on a team write maps to the name clash on any P2002, or on a message naming `team_name_lower_key` — why: the name index is the only unique constraint a create or rename can hit — where: `auth/src/teams/nameTaken.ts`
- scope: the `DELETE` route sits behind the admin guard, so a non-admin gets 401/403, not 405 — why: AC-3.1 says every route — where: `auth/src/teams/admin.routes.ts`
- assumption: `auth/src/openapi/*` needs no edit (the registry documents mounted routers) — why: `setupOpenAPI` is generic — where: `auth/src/openapi/registry.ts`

## T11 · backend-dev · 2026-11-26
- default: `TeamsRead` is `{teams, unavailable}`. `unavailable` maps each failed id to the last name and archived state of any held entry, or `null`. An id auth does not know is in neither part. — why: the view needs name and archived for a team whose members failed (plan table), and T12 needs "unknown" kept apart from "unavailable" — where: `projects-api/src/lib/teams.ts`
- assumption: an attached id missing from the read counts as unknown, so `onProject` returns `"unavailable"` and `onProjectKnown` marks it incomplete. Unknown is never read as an empty team. — why: D3 "unknown is not nobody"; teams are never deleted, so a missing id is a fault, not a state — where: `projects-api/src/projects/onProject.ts`
- default: `cached()` joins an in-flight read of the same id, but `fresh()` never does. A fresh answer stores into the cache only if its send time is not older than the held entry (out-of-order guard, ties go to the newer answer). — why: AC-1.3 needs the NEXT load to show a rename, and the bound of AC-4.6 depends on send stamps — where: `projects-api/src/lib/teams.ts`
- default: `fresh(ids, {fallback})` uses an entry of at most 60 s on a failed read only when `fallback` is true. The view passes true and the PUT passes false. — why: plan read-modes table — where: `projects-api/src/lib/teams.ts`
- default: the piggyback carries only entries older than 15 s and not past 60 s, and entries are forgotten after 10 min (memory only). — why: an entry past 60 s is never used; the 10 min limit only bounds memory — where: `projects-api/src/lib/teams.ts`
- default: an id shaped unlike an auth id (outside `^[A-Za-z0-9_-]{1,64}$`) is never sent and reads as unknown. — why: one bad id would make auth 400 a whole chunk of 50 — where: `projects-api/src/lib/teams.ts`
- scope: the reader's options read throws the 503 `teams_unavailable` problem and takes `q` as given, omitting it only when empty. — why: T12's route trims and validates `q` before calling — where: `projects-api/src/lib/teams.ts`
- reinterpretation: when both windows would refuse, `admitTeamRead` tells the person it is theirs (`window:"person"`). The 1..600 remainder is `ceil(ms/1000)` clamped. — why: D15 says a person is not told they did something wrong only when the service alone refused; if theirs is exhausted too, it is true and actionable — where: `projects-api/src/lib/rateLimiter.ts`
- default: the first-refusal log line lives in `admitTeamRead`, one per person and window per 10 min, with a swept memory map. — why: the limiter module owns the window state — where: `projects-api/src/lib/rateLimiter.ts`
- default: the limiter gained `reset()` and a `clock` option, used by `resetWorld()` and `advanceTime()`. — why: tests must clear module-scope instances and move time without sleeping — where: `projects-api/src/lib/rateLimiter.ts`, `projects-api/src/test-support/world.ts`
- scope: three files outside the `touch:` list: `src/migration.attachedTeam.test.ts` (new, proves the migration clause), `src/test-support/world.teams.test.ts` (new, tests the stub through the real reader), `src/migration.purchaseOrder.test.ts` (migration count 3 → 4). — why: the done-when names the migration check; an unexercised stub would pass its bugs on; the count test would fail otherwise — where: as listed
- reinterpretation: the `chr(0)` clause was dropped from `attached_team_id_shape` (plan drift: Postgres rejects `chr(0)` itself; a text value cannot hold NUL). — why: the plan's SQL does not run — where: `projects-api/prisma/migrations/20261126120000_attached_team/migration.sql`

## T3 · backend-dev · 2026-11-26
- default: an add whose person is already a member is a 200 no-op even if the team is at 100, and a re-add of a member who has since been deactivated is 422 `user_not_active`. Order is 404, then user active, then already-member, then limit — why: plan says "already a member: no-op" and "unknown or soft-deleted: 422" — where: auth/src/teams/admin.routes.ts
- default: audit rows use `targetType: "team"` and `targetId` = the team id for the member actions, not `team_member` — why: the plan's audit section says rows have `targetType: team` — where: auth/src/teams/admin.routes.ts
- assumption: the 422 `detail` strings are "Only an active user can be added to a team" and "A team has at most 100 members, deactivated ones included" — why: the plan fixes the codes and `limit`, not the text — where: auth/src/teams/admin.routes.ts
- assumption: `DELETE …/members/{userId}` takes `userId` as 1..128 characters; a longer or unknown id is a no-op 200, not a 400 — why: removal never needs to leak whether an id is valid — where: auth/src/teams/admin.routes.ts
- scope: `TEAM_MEMBER_LIMIT` is exported from repo.ts for reuse — why: avoids a second literal 100 — where: auth/src/teams/repo.ts

## T13 · backend-dev · 2026-11-26
- reinterpretation: meeting-host answers `true` when the caller is found in any readable attached team, even if another attached team is unknown; it returns 503 only when the caller is not found and the answer is incomplete — why: team members only ever add people, so a positive found from known facts cannot be wrong, and this avoids a needless 503 — where: `projects-api/src/meeting-host/meeting-host.routes.ts` (uses `onProjectKnown`, not `onProject`)
- default: a team that auth doesn't know (not in the answer) counts as unknown, so activity-host answers `null` and meeting-host answers 503, never "no members" — why: D3, unknown is not nobody — where: both routes via `factsOrUnavailable`/`onProjectKnown`
- scope: no 503 is raised for projects the caller can't open (`closed`/`missing`) or for no-team projects, even when auth is down — why: a decision needs the teams only where it reads them — where: `meeting-host.routes.ts`
- assumption: `Cache-Control: no-store` on the meeting-host 503 body is not asserted; it depends on how the global `onError` builds the response — why: T13's done-when does not require it; not verified — where: `meeting-host.test.ts`
- default: the team read for all projects in one resolve batch is a single `teamReader.cached` call over the distinct ids — why: matches the cached-path design (D2) and bounds auth calls per resolve — where: both routes

## T4 · frontend-dev · 2026-11-26
- scope: `/teams/$id` is registered with `NotFoundPage` as a placeholder so typed `Link`/`navigate` compile; T5 replaces the component — why: the list links to it — where: `admin-ui/src/router.tsx`
- scope: `TeamFormDialog` supports `edit` mode, `submitBlocked` and a form-level `error` now, although only create is wired — why: T5's touch list does not include `TeamFormDialog.tsx` — where: `admin-ui/src/components/TeamFormDialog.tsx`
- assumption: the dialog hands `{name, description}` with `''` for no description, and the page maps it (create omits it, edit sends null) — why: only the page knows which — where: `TeamFormDialog.tsx`, `TeamsPage.tsx`
- default: any create failure other than a clash with `existingName` shows the generic `createFailed` rather than the server `detail` — why: `detail` is English only (AC-3.3, design G1) — where: `admin-ui/src/pages/TeamsPage.tsx`
- default: filtering and search happen in the browser over the full list, literal and case-insensitive on the trimmed text — why: plan D12 — where: `admin-ui/src/pages/TeamsPage.tsx`
- default: the 403-in-place state is `PermissionDenied` with heading level 3, and New team is hidden while denied — why: matches `RolesPage` and design S1 — where: `admin-ui/src/pages/TeamsPage.tsx`
- scope: `teamNameClash` lives in `adminApi.ts` — why: T5's edit save needs the same rule — where: `admin-ui/src/lib/adminApi.ts`
- scope: `strings/common.ts` notFound body now mentions Teams (outside T4's touch list) — why: design.md Copy names it — where: `admin-ui/src/strings/common.ts`
- assumption: the "Active members" column shows `activeMemberCount` through `formatNumber` — why: design S1 — where: `admin-ui/src/pages/TeamsPage.tsx`
- default: the team state map (active → `active`, archived → `voided`) lives in `TeamStatusBadge.tsx` — why: design component inventory — where: `admin-ui/src/components/TeamStatusBadge.tsx`

## T12 · backend-dev · 2026-11-26
- ENV-FAULT (recorded): a first `db:deploy` with a wrong URL applied `20261124160000_project_tender_deal` and `20261126120000_attached_team` to the DEV database `projects` (both additive, on main; data intact — 134 projects, `project_attached_team` empty). Left in place, pending the user's word.
- scope: new file `src/projects/teamView.ts` holds the team half of the view (`TeamsOutcome`, `readTeamsForView`, `teamFields`) — why: `projects.routes.ts` and `teams.routes.ts` would otherwise import each other — where: `projects-api/src/projects/teamView.ts`
- scope: edited `projects.test.ts` (two full-shape `toEqual` expectations gained the five new fields), not in T12's touch list — why: the Project contract grew — where: `projects-api/src/projects/projects.test.ts`
- default: `toProjectView(c, row, teamsRead?)` takes the outcome of a team read already made; absent, it reads itself. `PUT …/teams` passes its own, so one request makes one call and counts once — why: plan § PUT step 4 — where: `projects.routes.ts`, `teams.routes.ts`
- default: the PUT's read uses `fallback: false` when a team is added and `fallback: true` when only removing — why: a write that must confirm never trusts a copy; the plan is silent for remove-only — where: `teams.routes.ts`
- default: the 429 problem body (PUT and attach search) is built in-handler with `Retry-After` and `no-store`; the attach-search 429 also carries `retryAfterSeconds` — why: `ProblemError` cannot carry headers and CORS hides `Retry-After` — where: `teams.routes.ts`
- default: when several refusals apply to added ids, 503 comes before 422 `team_not_found`, before 422 `team_archived` — why: the plan does not order them; an unreadable team cannot be judged — where: `teams.routes.ts`
- default: an id of the wrong shape or unknown to auth is `team_not_found` on add; on a view it is a team that could not be loaded (`unavailable`) — why: D9, "unknown is not nobody" — where: `teams.routes.ts`, `teamView.ts`
- default: `q` validated by zod (raw ≤ 200, no NUL, trimmed ≤ 80, blank = no search); the limiter runs before validation so malformed requests count — why: plan counts 400s but not 403s — where: `projects.schemas.ts`, `teams.routes.ts`
- default: a person counted only through a team is named from the team read (D10) — where: `teamView.ts`
- assumption: the OpenAPI doc has no named `Project` component, so the schema test reads the PUT's 200 response schema — where: `projects.schemas.test.ts`
- assumption: invariants exported as `ProjectTeamsInvariants` (ProjectSchema + `superRefine`) for tests; `ProjectSchema` stays plain for OpenAPI — where: `projects.schemas.ts`
- assumption: "service window full" in tests consumes the real 2 400 limit rather than a test-sized window — why: `world.ts` has no hook and was off limits — where: `teams.pageLimit.test.ts`

## T14 · backend-dev · 2026-11-26
- default: `/attached-teams` takes a team's name and archived flag from a stale cache entry when the refresh fails, and uses `null`/`null` otherwise — why: plan says name may be null and fail-soft; an old name is better than none for a filter that decides nothing — where: `projects-api/src/projects/teams.routes.ts`
- default: a team auth does not know is listed as `name: null, archived: null`, sorted last, not dropped — why: the filter must still reach projects carrying it; unknown is not nobody — where: `projects-api/src/projects/teams.routes.ts`
- default: `teamId` validated with the existing `IdSchema` (1–64 characters, no charset rule), as in plan.md — where: `projects-api/src/projects/projects.schemas.ts`
- default: the matrix row uses `need: "access"`, as `GET /project-managers` — why: plan says `authorized` only — where: `projects-api/src/matrix.test.ts`

## T9 · backend-dev · 2026-11-26
- default: `TEAM_READERS` is an exported frozen object checked with `Object.hasOwn`, and an unbound `sub` fails inside `verify`, counting against the invalid-credential address count — why: same 401 for every failure; `hasOwn` stops `system:__proto__` — where: `auth/src/teams/system.routes.ts`
- default: inactive members are ordered by id, not by their hidden names — why: ordering by a name returned as `null` would leak it — where: `auth/src/teams/system.routes.ts`
- assumption: options ordering ("name, then id") uses the database's default collation, not `Intl.Collator("it")` — why: `LIMIT 51` is applied in SQL; the admin list uses the collator, so accented names may order slightly differently between the two — where: `auth/src/teams/system.routes.ts`
- default: `q` lengths counted in code points (80 trimmed, 200 raw), plus NUL and well-formed-string checks — why: the name CHECK is `char_length` — where: `auth/src/teams/system.routes.ts`
- default: the query parser rejects any parameter other than `ids`, `state`, `q`, any repeated parameter, an `ids` value over 3 249 raw characters; `state` must be exactly `active` — why: "anything else 400" with no first-wins ambiguity — where: `auth/src/teams/system.routes.ts`
- default: the 400 uses a frozen `application/problem+json` body (`validation_failed`, instance `/system/teams`), `no-store` — why: never echoes the request — where: `auth/src/teams/system.routes.ts`
- default: the accepted-call log line is written only after a successful read; a 400 logs no `teams.read` line — why: `count` is known only after the read — where: `auth/src/teams/system.routes.ts`
- default: `holdersOfAppAccess` returns an `Effect` of a `ReadonlySet`, two queries regardless of size, no `deletedAt` filter (the route sends only active members) — why: matches neighbouring resolver functions; proven by the contract test — where: `auth/src/authz/resolver.ts`
- default: the route's `client` is injectable, so tests pass a counting proxy — why: spies do not see Prisma delegates — where: `auth/src/teams/system.routes.ts`
- scope: `auth/.env.example`'s placeholder projects-api line includes `teams:read` (outside T9's touch) — why: an existing test pins it against `DOCUMENTED_CLIENT_SCOPES` — where: `auth/.env.example`
- scope: `DOCUMENTED_CLIENT_SCOPES["projects-api"]` gains `teams:read` as sixth scope, with a comment to grant it only after this auth is live — where: `auth/src/system/serviceClients.ts`

## T10 · devops · 2026-11-26
- scope: the runbook is a new top-level "Teams rollout" section in infra/README.md — why: there is no Projects section; other features each have a rollout section — where: infra/README.md
- default: `teams:read` is added to the production `auth.env` template, which stands for the target contract, not the deployed value; the README says production gets it only after the step-2 auth is live — why: env-doctor compares that template with `requiredScopes` (hours-api `meetings.hosts.read` precedent) — where: tools/env-doctor/templates/production/auth.env
- assumption: no Changeset — why: env-doctor has no package.json and is not in lerna.json — where: .changeset
- assumption: `tools/env-doctor/push.test.ts` fails on main before this change too (verified by the orchestrator: the notify-api production template ships `PUSH_ENABLED=true`); left alone, out of scope — where: tools/env-doctor/push.test.ts

## T5 · frontend-dev · 2026-11-26
- scope: added `TeamDetail.it.test.tsx` beyond the touch list — why: the catalog language is read at module load (precedent `ProtectedChange.it.test.tsx`) — where: `admin-ui/src/pages/TeamDetail.it.test.tsx`
- default: add and remove adopt only `members` and `activeMemberCount` from the answer, keeping the page's team `version`, name and description — why: a rename done elsewhere is still caught by the next edit — where: `TeamDetail.tsx` `adoptMembers`
- default: edit, archive and restore replace the whole team from the answer and clear `stale` — why: the answer to our own versioned write is the freshest picture — where: `TeamDetail.tsx` `adopt`
- default: an edit with nothing changed closes the dialog without a request — why: PATCH requires at least one field — where: `TeamDetail.tsx` `handleEdit`
- default: the stale banner is hidden while any dialog is open — why: design S4 — where: `TeamDetail.tsx`
- default: a stale archive or restore uses `stale.body` as the dialog error and `stale.confirmReason` as Confirm's reason — why: design S4 item 3 — where: `TeamDetail.tsx` `handleConfirm`
- assumption: the 100-member limit is a constant in the page; the 422 `team_full` message uses it because `ApiProblem` does not carry `limit` — where: `TeamDetail.tsx` `TEAM_MEMBER_LIMIT`
- default: the picker filters out current members in the browser after `listUsers`, so a page of 10 can show fewer — why: the directory has no exclusion parameter — where: `TeamDetail.tsx` `searchUsers`
- default: at 100 members the limit text is its own `<p>` referenced by Add's `aria-describedby` — why: `SearchPicker`'s hint would take the field's id — where: `TeamDetail.tsx`
- default: after add/remove focus goes to the picker input; after archive/restore to the heading — why: design F6/F7, a11y — where: `TeamDetail.tsx`
- default: the page is keyed by team id — why: the route reuses the component when only the param changes — where: `TeamDetail.tsx`
- default: tests assert the dd.mm.yyyy date with a regex for the time part — why: `formatDateTime` uses the local time zone — where: `TeamDetail.test.tsx`

## T15 · frontend-dev · 2026-11-26
- scope: Retry reloads the project in place (`getProject` + `resource.replace`), not `resource.retry()` — why: design G8; `resource.retry()` unmounts the card via the loading state — where: `projects-ui/src/pages/ProjectDetailPage.tsx`, `AttachedTeams.tsx`
- reinterpretation: a deactivated member shows only the Deactivated badge, never also "No access to Projects"; the legend appears only when an active member lacks access — why: auth reports `appAccess:false` for every deactivated account, so a second badge would be misleading and the legend false — where: `AttachedTeams.tsx` (`lacksAccess`), pinned in `TeamCard.test.tsx`
- default: `rate_limited` with `onProjectComplete` not false reads as "unavailable" — why: no such row in the Status rule; fail toward "could not be loaded" — where: `projects-ui/src/lib/teamsStatus.ts`
- assumption: the five new `Project` fields are optional in the type; the card reads `project.teams ?? []` — why: never throw on an older projects-api — where: `projects-ui/src/lib/types.ts`
- scope: `TeamCard`'s `onSaved` takes `(next, message)` and gains a required `onReloadTeams` prop — why: distinct saved messages for people and teams — where: `TeamCard.tsx`, `ProjectDetailPage.tsx`
- scope: new `lib/teamsStatus.ts` and three badges in `Badges.tsx`, outside the touch list — why: shared by dialog and section; the design says the badge map lives in `Badges.tsx` — where: as named
- scope: `ProjectDetailPage.scope.qe.test.tsx` updated for "Edit people"/"Edit teams" — why: design-mandated label rename — where: that test
- default: the search call is `searchActiveTeams`, not `listAttachableTeams` — why: the D38 guard in `lib/api.test.ts` rejects any `/attach/` export name — where: `projects-ui/src/lib/projectsApi.ts`
- assumption: a dialog row for a team with no name reads "Team that could not be loaded" (new key `dialog.unnamed`) — why: S7 describes it but the Copy block has no key — where: `projects-ui/src/strings/project.ts`
- assumption: after Remove in the dialog, focus goes to the next Remove button, else to the "Attached teams" label — why: focusing the picker would fire a search — where: `TeamsDialog.tsx`
- default: the People dialog keeps its title "Edit team"; only the opener's label and the empty line changed — why: design marks only `edit` and `empty` — where: `projects-ui/src/strings/project.ts`
- default: the "Too many requests" banner body is one string (lead + wait + consequences) — why: design S6 — where: `AttachedTeams.tsx`
- note: Italian copy for the new keys follows design.md's impersonal register ("Riprovare…") although projects-ui otherwise uses "tu" — for QE/eval to judge

## T16 · frontend-dev · 2026-11-26
- scope: edited `projects-ui/src/strings/tasks.ts` (`tasks.form.membersIncomplete`, and `errors.assigneeNotOnProject`'s value), outside the touch list — why: design.md puts those keys there — where: `strings/tasks.ts`
- default: the shared helper `peopleOnProject` (with the R6 fallback) lives in `lib/recordHours.ts` and `TaskFormDialog` imports it — why: one fallback for both consumers — where: `lib/recordHours.ts`
- default: the filter-feed call is `getTeamFilterOptions` / `TeamFilterOption`; the D38 guard is untouched — where: `lib/projectsApi.ts`
- assumption: a current assignee absent from an incomplete list is shown by plain name, not "(no longer on the project)" — why: G10; departure is unknown while teams are not loaded — where: `TaskFormDialog.tsx`
- default: an unreadable team (`name: null`) is labelled "Team that could not be loaded" under new key `projects.list.teamUnreadable` — why: S8 describes it without a key — where: `strings/projects.ts`
- default: the Team filter's hint shows "No team is attached…" only once loaded with zero items, and "could not be loaded" on error — why: S8 — where: `ProjectsPage.tsx`
- default: `ProjectsPage.test.tsx` default routes include `GET /attached-teams` → empty — why: the fake API 404s unknown routes — where: `ProjectsPage.test.tsx`
- default: AC-4.9 in the UI is covered by a test only — why: the PM filter and pickers already list people only — where: `ProjectsPage.test.tsx`

## T6 · frontend-dev · 2026-11-27
- scope: added a third test whose only job is to prove `cleanupTeams` removed the run's teams — why: a cleanup that silently fails cost two rounds of leftovers in the shared dev DB — where: `shell/e2e/admin-teams.spec.ts`
- default: the non-admin check is a plain seeded employee (no Admin tool access), with the team the person belongs to created first — why: an empty list could otherwise be mistaken for "nothing to show" — where: `shell/e2e/admin-teams.spec.ts`
- default: `cleanupTeams` also deletes `audit_log` rows with `targetType: 'team'` for the run's teams — why: audit rows are Tier 2 and would otherwise accumulate in the dev DB — where: `shell/e2e/helpers/teamsFixtures.ts`
- assumption: the DB bridge uses `bun -e` with a `direnv exec .` fallback, as `inviteFixtures` and `legalEntitiesFixtures` do — why: touch list excludes `auth/scripts`, so no new script — where: `shell/e2e/helpers/teamsFixtures.ts`
- assumption: skipped three global-setup steps (accounting seed, refund release, legal-entities setup) for the verification run — why: they fail on the dev stack for reasons unrelated to teams (env faults) — where: run command only, no code change

## T17 · frontend-dev · 2026-11-27
- scope: the "PM" is a real `project-manager` persona with entity welld_ch (role plus entity set through auth's admin API), not the admin — why: it makes AC-4.1's `out_of_scope` check on a welld_it project meaningful — where: `teamsFixtures.ts` `seedProjectManager`
- assumption: the person without Projects access is a user with no role at all (employee grants nothing in Projects) — why: matches the seed; the "No access to Projects" badge confirmed it — where: `projects-teams.spec.ts`
- default: the over-limit persona is made per run and reads `GET /projects/{id}` until the server says `rate_limited`, rather than a fixed count — why: works whatever the exact limit, and a re-run within 10 min uses a new sub — where: `projects-teams.spec.ts` test 4
- reinterpretation: AC-5.6's "back under the limit shows the teams again" is left to the projects-api unit tests (`advanceTime`) — why: it needs 10 minutes of real time or a test-only route, which must not be added — where: spec header
- default: hours entries are recorded through hours-api and the removal is polled there, not through the dialog — why: that checks the real cache bound of AC-4.6; the Record hours offer on the page is checked in the UI — where: `projects-teams.spec.ts` tests 2 and 5
- default: run-tagged projects are left in place (no delete route) after their teams are detached, as the other projects specs do — why: no product route removes them — where: `projects-teams.spec.ts` afterAll
Note (orchestrator): first run failed on an env fault (dev `activities` DB 3 migrations behind main); applied with the user's approval, re-run 6/6 passed (1.0 m) with E2E_SKIP_ACCOUNTING_SEED / _REFUND_ACCOUNTING_RELEASE / _LEGAL_ENTITIES_SETUP.

## T18 · devops · 2026-11-27
- default: the `teams:read` service-client wording carries the "add only after the auth that knows the scope is live" note — why: the plan's Delivery step 3 and the operator-facing ordering rule — where: AGENTS.md Domain language § Identity
- scope: a one-line `auth/` structure comment and a teams clause inside the existing `projects-api` bullet, not new bullets — why: the teams ADR lines are already in the Architecture decisions list — where: AGENTS.md
- assumption: the two hours-api `src/lib/env.test.ts` failures are not this feature's — why: caused by commit 08758806 (the user's local env setup, removed `DATABASE_URL` from `hours-api/.env.example`), no teams commit touches either file — where: hours-api/src/lib/env.test.ts
Note (orchestrator): gates green for every touched app except two red gates outside this feature — env-doctor `push.test.ts` (pre-existing on main) and hours-api `env.test.ts` (08758806); both offered to the user as separate fixes. `/wellforge:done` runs after QE, security and eval.

## QE D1 fix · backend-dev · 2026-11-27
- default: the NUL refusal is a `refine` on the shared `IdSchema`, and the auth schemas use a local `noNul` refine, with no new shared module — why: smallest change that covers the whole class — where: `projects-api/src/lib/http.ts`, `auth/src/teams/admin.routes.ts`
- scope: unified the two host-route private `IdSchema` copies onto the shared one — why: removes the duplicated rule so it cannot drift — where: `activity-host.routes.ts`, `meeting-host.routes.ts`
- scope: did not touch free-text fields in projects-api (`requiredText`/`optionalText`) or auth departments, roles and users routes; listed as follow-ups — why: the fix was limited to ids and the teams admin schemas — where: n/a
- reinterpretation: "value absent from the body" was tested on everything except `instance`, which is the request path — why: this is the services' standing problem shape, and changing it is out of scope — where: `projects-api/src/projects/nul.test.ts`, `auth/src/teams/admin.nul.test.ts`
- default: the changeset is a new patch file instead of extending the existing minor ones — why: it keeps the fix a visible patch — where: `.changeset/teams-nul-refused.md`

## Eval round 1 fix — Italian register · frontend-dev · 2026-11-27
- scope: also changed admin-ui's Italian teams strings, not only projects-ui — why: fix the class; `teams.ts` mixed infinitive imperatives with "tu" — where: `admin-ui/src/strings/teams.ts`
- assumption: "tu" is the register for admin-ui teams because the newer admin screens (`legalEntities`, `accessRequests`) and projects-ui use it, though older `roles` and `address` use the infinitive — why: makes the suite consistent — where: `admin-ui/src/strings/teams.ts`
- scope: left the pre-existing sentence "Usare la navigazione…" in `admin-ui/src/strings/common.ts` untouched; only its list of sections changed — why: an existing string whose register predates this feature — where: `admin-ui/src/strings/common.ts`
- default: kept the impersonal "Si possono…" and infinitive-as-subject forms ("Rimuovere un team toglie…") — why: not imperatives, match existing strings — where: `projects-ui/src/strings/project.ts`

## Eval round 1 fix — plan D16 host wait · backend-dev · 2026-11-27
- scope: allowed `RESOLVE_TIMEOUT_MS` in meetings-api's AC-11.10 export-surface test, keeping the callable surface at `resolve` and `sendNotice` — why: the plan-mandated export otherwise fails that test; a constant adds no way to call a host — where: meetings-api/src/hosts/client.test.ts
- scope: added `hold` and `delayMs` switches to the fake auth in the shared test world — why: the integration tests need a slow-but-answering auth, which `down`/`failNext` could not express — where: projects-api/src/test-support/world.ts
- default: per-chunk outcome on timeout — a chunk that settled before the timer is used as answered, only the still-running ones count as `wait_exceeded` — why: the plan says "a flight that settles in time settles as today" — where: projects-api/src/lib/teams.ts
- default: only a projects-api patch changeset, none for meetings-api — why: the meetings-api change exports an existing constant with no behaviour change — where: .changeset/teams-host-wait.md
