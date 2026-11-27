# QE report — specs/20261126-teams (rigor: production, full mode)

## QE verdict: PASS        (round 2 re-verification, measured at 68c59172; fix 242c700b + 2ea04944)

Round 2 (eval fix round: D16 host wait, Italian register): nothing BLOCKED, no defect. The round-2 section at the end of this file is the
current pass; the round-0 and round-1 sections below are kept as measured then (round 1: PASS at 95d92e80).

## Superseded: QE verdict round 1: PASS        (round 1 re-verification, measured at 95d92e80; fix 05d2981b, tests ed8e160b)

Round 1: D1 is fixed on every placement, live and in tests; full suites, typecheck and the e2e are green. Nothing is BLOCKED. One new finding, D2
(the same NUL class on routes that exist before this feature and are outside its diff), is recorded below and does not gate this feature;
the caller decides whether to widen the fix. The first-pass tables below are kept as measured at b44845e4 (rows marked "round 0");
the round-1 section at the end supersedes them where it says so. Three e2e global-setup steps were skipped as environment faults
(listed below); none of them is on a teams path.

| Check | Threshold | Actual | Result |
|---|---|---|---|
| AC coverage (31 ACs, each traced to an executed test) | 31/31 | 31/31 (table below) | ✓ |
| auth tests (`operai_auth_test`, clean env) | 0 fail | 1680 pass, 0 fail before QE tests; QE `admin.nul.qe.test.ts` adds 6 red + 1 green | ✗ (D1) |
| projects-api tests (`projects_test`) | 0 fail | 1466 pass, 0 fail before QE tests; QE `teams.nul.qe.test.ts` adds 1 red + 1 green | ✗ (D1) |
| activities-api tests (`activities_test`) | 0 fail | 820 pass, 0 fail | ✓ |
| hours-api tests (`hours_test`) | 0 fail | 1876 pass, 2 fail (`.env.example`, not this feature, see Pre-existing) | ✓ for the feature |
| admin-ui vitest | 0 fail | 65 files / 1184 tests pass | ✓ |
| projects-ui vitest | 0 fail | 51 files / 1101 pass (+2 expected fail) | ✓ |
| Line coverage, feature files (bun: Funcs / Lines) | ≥80% | auth `teams/*` 100 / 96.7–100; `system.routes` 100 / 100; projects-api `lib/teams.ts` 86.1 / 98.9, `rateLimiter` 100 / 96.7, `onProject` 100 / 100, `teamView` 100 / 100, `teams.routes` 100 / 99.3, hosts 100 / 100; activities `hosts/registry` 100 / 100, `client` 90 / 100; hours `bookability` 100 / 100 | ✓ |
| Coverage, whole services | ≥80% | auth 95.0 / 97.2; projects-api 96.6 / 98.0; activities-api 93.0 / 93.5; hours-api 98.9 / 99.2 | ✓ |
| Coverage, UI feature files (vitest v8, statements) | ≥80% | admin-ui `TeamDetail` 95.4, `TeamsPage` 95.5 (all admin-ui 97.1); projects-ui `AttachedTeams` 97.9, `TeamCard` 94.5, `TeamsDialog` 97.2, `teamsStatus` 93.8, `ProjectsPage` 98.6 (all projects-ui 95.5) | ✓ |
| Typecheck (auth, projects-api, activities-api, hours-api `tsc --noEmit`; admin-ui, projects-ui `tsc -b` in build; shell e2e `tsc -p tsconfig.e2e.json`) | clean | clean | ✓ |
| Lint (admin-ui, projects-ui, shell `eslint .`) | clean | clean | ✓ |
| Build (admin-ui, projects-ui) | succeeds | succeeds | ✓ |
| Secret scan (`betterleaks git ad7a0719..HEAD`) | no leaks | no leaks found | ✓ |
| Dependency audit | no critical CVE | no `package.json` or lockfile change in the feature diff, so nothing new to audit | ✓ (n/a, evidence: `git diff --name-only ad7a0719..HEAD`) |
| Changesets | one per touched app | 7 files (auth x2, admin-ui, projects-api, projects-ui, activities-api, hours-api) | ✓ |
| e2e (author's) `admin-teams`, `projects-teams` | pass | 3 + 6 passed (re-run) | ✓ |
| e2e (QE exploratory, new) | pass | `teams-qe-exploratory` 9, `projects-teams-qe-exploratory` 5: all pass | ✓ |
| Design states (design.md S1–S9), admin | all present | list denied/loading/failed/empty/no-match/loaded, detail 404/archived/stale/full/deactivated, create 409, remove/archive/restore confirms: present (unit tests + e2e); stale, clash, remove-confirm, deactivated and search driven in a real browser by QE | ✓ |
| Design states, projects | all present | teams section, archived mark, no-access mark, unavailable and rate-limited banners with Retry, Edit teams dialog, filter: present (unit + e2e; unavailable banner only in jsdom, see Observations) | ✓ |
| Accessibility (design.md § Accessibility) | keyboard + ARIA per design | keyboard-only: picker, Add, Remove confirm (focus lands on Cancel, Tab to Confirm, Enter), Edit teams dialog attach and save, focus not lost to `<body>` after either dialog; no horizontal page scroll at 360 px on admin list/detail (80-char name, 500-char description, hostile markup rendered as text) and on a 25-person team card | ✓ |
| Component reuse (design.md inventory) | reuse, no new copy | `TeamsDialog`, `AttachedTeams` are projects-ui's own (inventory-listed); `SearchPicker`, `ConfirmDialog`, `FormDialog`, `DataTable` from `@operai/ui`; ESLint design-token rules clean | ✓ |
| i18n AC-3.3 | en + it complete | `catalogGaps` parity tests green; real browser at `it-IT`: `lang="it"`, no English chrome | ✓ |
| Input validation (NUL in ids/names), round 0 | 4xx, never 5xx | 500 on 7 placements (D1) | ✗ (round 0; fixed, see Round 1) |

## Defects

### D1 — U+0000 in text input reaches Postgres and answers 500 (owner: code; plan assumption false)

Class: a text id or name containing a NUL is accepted by the zod schema, then Postgres refuses it ("invalid byte sequence for encoding UTF8: 0x00",
Prisma P2039) and the route answers 500 instead of 400/422. plan.md line 726 says the `q` check is "no NUL ..., as `IdSchema`"; `IdSchema`
(`projects-api/src/lib/http.ts:123`, `z.string().min(1).max(64)`) does not refuse NUL, so the plan's premise is wrong (the architect's lead is confirmed).
Not a data or security exposure (no body echo, admin-only on the auth side, authenticated on the projects side), but a 5xx on caller input
in a production-tier feature, with a one-line fix per schema.

Placements (checked all):

| Placement | Result | New in this feature? |
|---|---|---|
| projects-api `GET /projects?teamId=<NUL>` (`projects.schemas.ts:231`, filter at `projects.routes.ts:269`) | ✗ 500 | yes (the lead) |
| projects-api `PUT /projects/{id}/teams` with a NUL team id | ✓ 422 (never reaches the table) | yes |
| projects-api `GET /projects?projectManagerId=<NUL>` | ✗ 500 | no, pre-existing, same `IdSchema` root cause (recorded, not a feature defect) |
| auth `POST /admin/teams` name with NUL | ✗ 500 | yes |
| auth `POST /admin/teams` description with NUL | ✗ 500 | yes |
| auth `PATCH /admin/teams/{id}` name with NUL | ✗ 500 | yes |
| auth `POST /admin/teams/{id}/members` userId with NUL | ✗ 500 | yes |
| auth `GET /admin/teams/{id}` id with NUL | ✗ 500 | yes |
| auth `DELETE /admin/teams/{id}/members/{userId}` userId with NUL | ✗ 500 | yes |
| auth `GET /system/teams` `q` / `ids` with NUL | ✓ 400 (`system.routes.ts:188`, tested) | yes |
| auth `GET /admin/teams` | n/a (no query parameters; search is client-side) | yes |
| auth departments routes (same pattern, pre-existing) | not probed | no |

Repro (both files are committed red, status "missed by the implementation tests", first QE pass so not "new since a fix"):
- `cd projects-api && env -i PATH="$PATH" HOME="$HOME" DATABASE_URL=<projects_test url> bun test src/projects/teams.nul.qe.test.ts` (1 fail: `GET /projects?teamId=`)
- `cd auth && env -i PATH="$PATH" HOME="$HOME" DATABASE_URL=<operai_auth_test url> bun test src/teams/admin.nul.qe.test.ts` (6 fail, plus one green harness-sanity test proving a clean create is 201)

Root cause: no schema in these routes rejects U+0000 before the database; the system route did (`includes("\u0000")`) but the admin routes and
`IdSchema` do not. Suggested fix shape (for the dev agent, not applied by QE): refuse NUL in `IdSchema` (fixes `teamId` and the pre-existing
`projectManagerId` together) and add a no-NUL refine to the team name, description and the admin id/userId params; then the QE tests turn green.
A fix that only catches the Prisma error and maps it to 4xx is acceptable only if it is the single choke point, not per route.

## AC → evidence

Backend evidence is from the assembled app against real Postgres test databases (bun), UI from vitest/jsdom, real-browser from Playwright e2e
(`admin-teams`, `projects-teams` by the authors; `teams-qe-exploratory`, `projects-teams-qe-exploratory` by QE).

| AC | Evidence | Result |
|---|---|---|
| 1.1 | auth `admin.routes.test` create/limits 1..80/500; admin-ui `TeamFormDialog`; e2e admin-teams | ✓ |
| 1.2 | auth `admin.routes.test` (409 + `existingName`, archived counts), `nameTaken.test`, db unique index `repo.test`; QE e2e clash in a real browser | ✓ |
| 1.3 | projects-api `teams.test` (rename shows next load); e2e projects-teams | ✓ |
| 1.4 | auth list; admin-ui `TeamsPage`; QE e2e case-insensitive substring, Active default, Archived on request, no-match state | ✓ |
| 1.5 / 1.6 | auth archive/restore, `system.routes.test` (archived not offered); projects-api `teams.test` (attached stays); QE e2e projects archived-stays-and-marked, not offered, re-attach 422 `team_archived` | ✓ |
| 1.7 | auth `admin.routes.test` DELETE 405; db RESTRICT `repo.test`; no `team-delete*` id in admin-ui | ✓ |
| 1.8 | auth `baseVersion` CAS; admin-ui `TeamDetail`; QE e2e: stale edit refused, typed text kept, banner, Reload shows other admin's rename | ✓ |
| 2.1 / 2.2 | auth `members.test`; e2e admin-teams add/remove; QE e2e keyboard add and remove | ✓ |
| 2.3 | auth `members.test` (deactivated refused 422, stays listed); QE e2e deactivated badge, count "2 of 100 … 1 deactivated", not offered to other teams | ✓ |
| 2.4 | auth `members.test` 100 limit, row-locked concurrent adds at 99 give one 200 and one 422; archived team editable | ✓ |
| 2.5 | auth `members.test` effective permissions identical before/after, no `perm_epoch` change; `resolver.static.test` catalog unchanged | ✓ |
| 3.1 | auth 403 on every route incl. reads, department-conferred admin refused; e2e admin-teams; QE e2e: direct `/admin/teams` leaves Admin (URL changes), no Teams tab | ✓ |
| 3.2 | auth audit rows per change, none on refusal; QE e2e via `GET /admin/audit`: one `team.create` + one `team_member.add` naming actor and the person (by email), a refused clash adds none | ✓ |
| 3.3 | admin-ui `catalogGaps` and no-hardcoded-strings tests; QE e2e `it-IT` | ✓ |
| 4.1 | projects-api `teams.test` (200, new ETag, 403 `out_of_scope`, 409 stale, 429, 503); projects-ui `TeamsDialog`; e2e projects-teams; QE e2e 10 ok / 11 refused and nothing changed | ✓ |
| 4.2 | see 1.5 | ✓ |
| 4.3 | projects-api view; projects-ui `TeamCard`; e2e viewer sees names, deactivated and no-access marks; QE e2e 25-person team at 360 px with "show all" | ✓ |
| 4.4 / 4.5 | `onProject.test`, `teams.test`, host tests: each person once in order, detach keeps listed and drops team-only | ✓ |
| 4.6 | `lib/teams.test` cache (30 s fresh, 60 s stale ceiling); e2e removal refused within a 65 s poll | ✓ |
| 4.7 | `holdersOfAppAccess.contract.test` (auth), `onProject.test`, host tests (no-access not counted, still attached, counts later); e2e Bob marked | ✓ |
| 4.8 | `attachedTeams.test` (filter, distinct, archived listed, unknown names last); `ProjectsPage.test`; e2e filter | ✓ (but `?teamId=` NUL, D1) |
| 4.9 | `teams.test`: team id as project manager 422 `not_project_user` | ✓ |
| 5.1 | hours-api `bookability.test` (null refuses 503); activity/projects integration; e2e records as team-only person, refused after removal, entries untouched | ✓ |
| 5.2 | activities-api `registry.test`/`client.test` (null assignees, 503, unchanged resend); projects-api `activity-host.test`; projects-ui `TaskFormDialog` (current assignee stays selectable); e2e task given | ✓ |
| 5.3 | projects-api `meeting-host.test` (team-only reader yes, gone after leaving, no-access closed, 503 when unknown and not listed). Not in e2e (no meetings journey for projects teams) | ✓ (integration level) |
| 5.4 | `teams.test` (view unavailable, names kept when held), `onProject`, activity-host null, meeting-host 503, hours 503; projects-ui `TeamCard` and `ProjectDetailPage` unavailable banner with Retry | ✓ (jsdom only for the UI, see Observations) |
| 5.5 | `teams.test` team-only person with `projects:access` cannot change; QE e2e PATCH and PUT teams both 403 | ✓ |
| 5.6 | `teams.pageLimit.test` (120 ok, 121st loads with every team marked and the wait, no effect on another person, no-team project uncounted, one log line); host tests never consult the windows; projects-ui banner and Retry; e2e over-limit persona | ✓ |

### AC-5.6 "teams return when back under the limit": is unit evidence enough?

Yes, with the caveat noted. Recovery is proven on the assembled projects-api app with a controlled clock
(`teams.pageLimit.test.ts`: "once the oldest read leaves the window the page is complete again", and a 600 001 ms advance), not only by a
limiter unit test, and the UI side (banner present, Retry reloads in place, banner gone when the project returns complete) is in
`ProjectDetailPage.test.tsx` around lines 1109–1182. The only unproven link is the same page recovering in a real browser after 10 real
minutes; the state that changes is server-side and the page render of a complete view is already driven in e2e (`projects-teams` first journey).
I did not wait 10 minutes. Residual risk is low; not a defect.

## Observations (not defects, no verdict effect)

- O-1: the limiters are per process (`rateLimiter.ts`); plan R12 states projects-api must stay at one replica (`.railway/railway.ts` shows 1).
  A second replica would exceed auth's `teams` allowance. Documented in the plan; no code guard.
- O-2: AC-5.4's "unavailable" page state and AC-5.3 meeting reading have no real-browser journey (auth cannot be stopped on the shared dev stack).
  Covered at integration and jsdom level.
- O-3: the audit summary names a person by email (`Added <email> to team "<name>"`), which meets "naming the person"; design G6's
  "Deleted user" vs "Deactivated" wording difference is acknowledged in the design.
- O-4: QE e2e tests are asserted against observable values (typed text kept, URL after redirect, audit rows); two of them (Italian, audit) were seen
  red while being written because of QE's own mistakes, then fixed. The others were not seen red against broken production code (no safe way to break it
  on the shared stack); the NUL tests are seen red against current code.

## Environment faults (not defects; no dev agent owns them)

The e2e runs used the author's three skips, reproduced:
- `E2E_SKIP_ACCOUNTING_SEED=1`: the WellD CH accounting seed fails on the dev stack. Not used by any teams journey.
- `E2E_SKIP_REFUND_ACCOUNTING_RELEASE=1`: refund approvals would answer 409 `accounting_release_pending`; no teams journey approves a refund.
- `E2E_SKIP_LEGAL_ENTITIES_SETUP=1`: the dev auth catalog lacks `legal-entity.manage`; unrelated to teams.
Checked: all three are global-setup steps for other modules, and the author journeys (3 + 6) and the QE ones (14) do not read their output.

## Pre-existing red gates (outside the feature diff)

- `hours-api/src/lib/env.test.ts` (2 fails, `hours-api/.env.example` > required variables / local defaults): caused by commit `08758806`
  (`chore(env): remove database URL from .env.example and add .envrc`), which is the only commit touching `hours-api/.env.example` or `.envrc` in
  `ad7a0719..HEAD`; the feature's hours-api commits are `18c8949c` (T8, `clients/projects*`, `targets/bookability*`) only. The T8 tests pass.
- `tools/env-doctor` `push.test.ts` "the production template ships push off ..." (1 fail, 299 pass): expects `PUSH_ENABLED=false` in the notify-api
  production template, which ships `true` since 2026-11-13; `push.test.ts` and `templates/production/notify-api.env` are not in the feature diff.

## Tests added by QE (committed on main)

- `b0b43170` `shell/e2e/teams-qe-exploratory.spec.ts` (9 journeys), `shell/e2e/projects-teams-qe-exploratory.spec.ts` (5 journeys), all green.
- `b44845e4` `auth/src/teams/admin.nul.qe.test.ts` (6 red + 1 sanity), `projects-api/src/projects/teams.nul.qe.test.ts` (1 red + 1 green): the red ones are the
  reproduction of D1 and stay red until a dev agent fixes it. Main is therefore red on those two files by design (QE bug-reproduction mode).

## Security

An `owasp-reviewer` pass is recommended: a new service credential scope (`teams:read`) and `TEAM_READERS` binding, a new auth `/system/teams` route with
frozen 401 and its own limiter, per-person rate limiting keyed on `sub`, a new live read that widens who may read meeting content (O8, accepted by the
user), and the D1 input-validation gap. QE found no secret in the diff and no new dependency.

## Blocked

None.


---

# Round 1 (re-verification after fix 05d2981b)  (measured at 95d92e80)

Between the fix and this pass only `plan.md` changed (95d92e80, the `instance` sentence). `instance` carrying the request path (a NUL in it as
`\u0000`) is accepted as the architect states; it is not counted as an echo below.

| Check | Threshold | Actual | Result |
|---|---|---|---|
| D1, every listed placement + the ones the fix added | 400 `validation_failed`, no value in detail/errors/field, nothing written | table below, 17 placements live, all as required | ✓ |
| QE red tests (`admin.nul.qe.test.ts`, `teams.nul.qe.test.ts`) | green | 6 + 1 sanity, 1 + 1: all pass | ✓ |
| Author tests (`admin.nul.test.ts`, `nul.test.ts`, `http.test.ts`) | green | 9 (+1 clean-404) / 4 / 3 pass | ✓ |
| auth `bun test` (`operai_auth_test`, clean env) | 0 fail | 1696 pass, 36 skip (pre-existing T9 skips), 0 fail | ✓ |
| auth `bun run typecheck` | clean | exit 0 | ✓ |
| projects-api `bun test` (`projects_test`, clean env) | 0 fail | 1476 pass, 0 fail (1466 before + the new NUL tests; the shared `IdSchema` and both hosts unified onto it are covered) | ✓ |
| projects-api `bun run typecheck` | clean | exit 0 | ✓ |
| e2e `admin-teams`, `projects-teams` (author) | pass | 3 + 6 pass | ✓ |
| e2e QE exploratory (`teams-qe-exploratory`, `projects-teams-qe-exploratory`) | pass | 9 + 5 pass (23/23 in one run, 1.4 min) | ✓ |
| Running services picked the fix up | live probe | auth :3001 and projects-api :8086 answer 400 where round 0 answered 500 | ✓ |
| Previously OK rows | unchanged | system `q`/`ids` NUL 400 (tests), PUT teams NUL id still 4xx (now 400, was 422), clean unknown id still 404, clean create 201 | ✓ |
| Pre-existing red gates | recorded | env-doctor `push.test.ts`, hours-api `env.test.ts` (08758806): not re-run, not touched by the fix | recorded |

Placement table (live, real admin session, dev stack; each answer `400 validation_failed` with the NUL only in `instance`; after the run the probe team was
unchanged: same name, version, description, members, no NUL in the list):

| Placement | Round 0 | Round 1 |
|---|---|---|
| auth `POST /admin/teams` name | 500 | 400 ✓ |
| auth `POST /admin/teams` description | 500 | 400 ✓ |
| auth `PATCH /admin/teams/{id}` name | 500 | 400 ✓ |
| auth `PATCH /admin/teams/{id}` description (added by the fix) | not probed | 400 ✓ |
| auth `POST /admin/teams/{id}/members` userId | 500 | 400 ✓ |
| auth `GET /admin/teams/{id}` id | 500 | 400 ✓ |
| auth `DELETE /admin/teams/{id}/members/{userId}` userId | 500 | 400 ✓ |
| auth same route, team id (added) | not probed | 400 ✓ |
| auth `PATCH`, archive, restore, id NUL (added) | not probed | 400 ✓ (x3) |
| auth `GET /system/teams` q/ids | 400 | 400 (tests; a user token gets 401 on the service route, as before) ✓ |
| projects-api `GET /projects?teamId=` | 500 | 400 ✓ |
| projects-api `GET /projects?projectManagerId=` | 500 (pre-existing) | 400 ✓ |
| projects-api `GET /projects/{id}` (added, path id) | not probed | 400 ✓ |
| projects-api `PUT /projects/{id}/teams` path id (added) | not probed | 400 ✓ |
| projects-api `PUT /projects/{id}/teams` NUL team id | 422 | 400 ✓ (now refused by the schema, never reaches the table) |
| projects-api activity-host / meeting-host resolve ids | 400 | 400 (same `IdSchema` now; their tests green) ✓ |
| clean ids (control) | 404 / 201 / 200 | unchanged ✓ |

## D2 — NUL in text input on routes outside the feature diff still answers 500 (new finding; pre-existing code, missed in round 0, not new since the fix)

Same class and root cause as D1 (no schema refuses U+0000 before Postgres), on code that predates specs/20261126-teams and that the fix did not touch.
Round 0 listed "auth departments routes: not probed" and did not probe projects `q`; that is the miss. Probed live in round 1:

| Placement | Result | In the feature diff? |
|---|---|---|
| projects-api `GET /projects?q=<NUL>` (`projects.schemas.ts:226`, `z.string().max(200)`; added in 4f8e70fd) | ✗ 500 | no (sits beside the teams filter on the same route) |
| auth `POST /admin/departments` name NUL | ✗ 500 | no |
| auth `GET /admin/users?q=<NUL>` | ✗ 500 | no |
| projects-api `GET /companies?q` | 503 (CRM not answering here), not conclusive | no |
| auth `GET /admin/audit?q`, `GET /admin/users?search` | 200 | n/a |

Not a data exposure (authenticated callers, no body echo), a 5xx on caller input. It does not gate this feature: no teams route is affected, and the
plan amendment scopes the NUL rule to ids and team text. Suggested shape for whoever owns it: one choke point (a shared `noNul` string helper in each
service, or the global `onError` mapping Prisma P2039 to 400 `validation_failed`) rather than per-route refines, since each fix so far found another route.
No red test is committed for D2 (it would leave main red outside the feature); repro: `GET /projects?q=%00` with any projects token.

## Tests added in round 1

None. The round-0 QE tests (b44845e4) are green and stay as regression guards; probe scripts were scratch only (not committed).
Side effect on the shared dev stack: one archived team `qe-nul-<timestamp>` and the user `qe-nul-probe@operai.test` (teams cannot be deleted by design).

## Self-critique

Round 0 listed placements only from the feature's routes and wrote "not probed" for the sibling routes instead of probing them; D2 is what that gap hid.
Round-1 live probes used a session cookie because the minted bearer is refused by auth `/authz/*` here (401, environment of the helper, not the fix).


---

# Round 2 — re-verification after eval fix round 2 (measured at 68c59172)

Scope: plan D16 (commit 242c700b, ADR amended 68c59172) and the Italian register change (2ea04944). Tree clean at 68c59172 before and after the pass;
mutations were applied and reverted with `git checkout` (final `git status` empty, see Mutation table). Backend tests ran on test databases only, with a clean env.

## QE verdict: PASS        (measured at 68c59172, full mode)

| Check | Threshold | Actual | Result |
|---|---|---|---|
| projects-api `bun test` (projects_test) | 0 fail | 1500 pass, 0 fail, 43 files | ✓ |
| meetings-api `bun test` (meetings_test), run in full (the dev had not) | 0 fail | 1995 pass, 0 fail, 82 files | ✓ |
| Typecheck `tsc --noEmit` projects-api, meetings-api, activities-api, hours-api | exit 0 | 0, 0, 0, 0 | ✓ |
| projects-ui `pnpm lint` / `test` / `build` | clean | clean / 1101 pass + 2 expected-fail (51 files) / built | ✓ |
| admin-ui `pnpm lint` / `test` / `build` | clean | clean / 1184 pass (65 files) / built | ✓ |
| e2e `admin-teams` + `projects-teams` | all pass | 9/9 (incl. the 65 s removal journey, AC-4.6) | ✓ |
| e2e exploratory `teams-qe-exploratory` + `projects-teams-qe-exploratory` (incl. Italian admin screen, AC-3.3) | all pass | 14/14 | ✓ |
| D16 vs plan text (constants 800 / 1 000 / 5 000; wait counted once per call; not aborted; joiner own full wait; fresh/options ignore it; no extra auth call) | every plan row has a test | all 13 unit + 4 cross-package + 3 integration rows present and green (69 pass over the three D16 files) | ✓ |
| Cross-package test fails when a constant drifts | mutate one, red, restore | 5 of 5 mutations red (below) | ✓ |
| Coverage `projects-api/src/lib/teams.ts` | lines >= 80% | 98.96% lines (86.67% funcs; uncovered 507-509 predate D16) | ✓ |
| Italian copy | one register, parity, no leftover infinitive imperatives | read in full (below) | ✓ |
| Dev projects-api picked up the change | running = committed | see "Dev stack" | ✓ (indirect) |
| Pre-existing red gates (env-doctor `push.test.ts`, hours-api `env.test.ts` from 08758806) | unchanged | not re-run; untouched by 242c700b/2ea04944 (diff lists no such file) | recorded as before |

## D16 against the plan

Read `teams.ts` `cached()` against plan § "Deadlines" and the test table (AC-4.6, AC-5.4):
- One `Promise.race([Promise.all(flightsNeeded), timer(hostWaitMs)])` for all the flights the call needs, timer cleared in `finally`: one wait per call, not per chunk or per id. A joiner takes the flights already in `flights` and gets its own timer.
- Flights are never aborted. `readIds` swallows every error into an `{ok:false}` outcome (try/catch at teams.ts:313-325), so the `void flight.then(...)` bookkeeping cannot produce an unhandled rejection. A late answer stores its entry stamped with its send time (the existing flight code, unchanged), so the next call within 30 s makes no call.
- `fresh()` and `options()` do not touch `hostWaitMs` (tests: answer released after the wait and before `timeoutMs` is returned as fact / options).
- The activity-host and meeting-host routes call only `teamReader.cached(`; `GET /attached-teams` shares the same call, as the plan table says.
- Integration with real constants: resolve answers within `[WAIT-100, WAIT+MARGIN)` with `assignees:null` for the project with a team and the listed set for the one without; a stale entry (40 s) is used and `teams_stale_used` logged; meeting-host 503 `teams_unavailable` for a team-only caller, PM answered with no auth call; `GET /projects/{id}` with a 1.5 s auth is still `complete`.

### Mutation proofs (each reverted; final `git status --short` empty, `teams.ts` mtime moved by my reverts only)

| Mutation | Red? by |
|---|---|
| activities-api `RESOLVE_TIMEOUT_MS` 2_000 -> 1_500 | cross-package "activities-api ... 2 000 ms, wait + margin under it" ✓ |
| hours-api `OWNER_TIMEOUT_MS` 2_000 -> 1_000 | cross-package hours-api row ✓ |
| `TEAMS_HOST_WAIT_MS` 800 -> 1200 | 4 cross-package tests (pins + three consumers) ✓ |
| meetings-api `export` removed from `RESOLVE_TIMEOUT_MS` | cross-package meetings-api row (absent declaration is a failure, never a skip) ✓ |
| activity-host route `cached(` -> `fresh(` | static route check + both slow-auth integration tests ✓ |
| default wait 800 -> 60 000 | 3 integration tests (5 s each) ✓ |
| wait made per flight (sequential) | unit "one wait per call: 120 ids in three held chunks" ✓ |
| abandoned flight forgotten (`flights.delete`) | unit "a call that starts while the flight runs joins it, own full wait" ✓ |

Side effect: the dev stack runs `bun --hot`, so these temporary edits briefly reloaded projects-api, meetings-api, activities-api and hours-api; each was restored and reloaded.

## meetings-api AC-11.10 export-surface assertion

AC-11.10 (specs/20261104-meetings): "what the host does is its own business; the Meetings tool never reads host data back". The module-surface test protects that `client.ts` offers exactly two ways to call a host: `resolve` and `sendNotice`. The loosened test still asserts that the only exported FUNCTIONS are `resolve` and `sendNotice` (runtime, `typeof === "function"`), and its static test still pins the full list of value exports from source, now including the literal line `const RESOLVE_TIMEOUT_MS = 2_000;`. A number cannot call, read back or send anything, so the property is intact. Two observations, not defects: (1) the static assertion pins the constant's literal, so changing the timeout needs a deliberate edit of that test (acceptable: it is a deadline other services are pinned against); (2) a future exported helper that is not a function (a client object, a class instance) would pass the runtime check but still fail the static list. Full meetings-api suite run: 1995 pass.

## Italian register

Read the diff (2ea04944) and the files in full: admin-ui `strings/teams.ts` and projects-ui `strings/project.ts` team copy now use the informal "tu" imperative throughout (`Crea`, `Aggiungi`, `Cerca`, `Ricarica`, `Riprova`, `Rimuovine`, `Rimuovili`, `Chiudi`, `Usa`, `Mostra`, `Scrivi`). A grep for the old infinitive imperatives and for formal "Lei" forms finds none left. The remaining infinitives are not commands: confirm-dialog questions (`Archiviare “x”?`, `Ripristinare “x”?`, `Rimuovere x?`, `Annullare questo progetto?` is a pre-existing non-teams string) and a subject (`Rimuovere un team toglie i suoi membri ...`), standard Italian. `Cerca per nome o email. Si possono aggiungere solo utenti attivi.` mixes tu and impersonal "si", acceptable (no addressee). Parity tests and the Italian e2e (admin Teams screen, AC-3.3, 14/14 file) pass. No browser journey renders projects-ui in Italian; its Italian copy is covered by unit parity and no-hardcoded-strings tests only (as in rounds 0 and 1).

## Dev stack

`projects-api` (pid 64792, `bun run --hot`) started 00:23, before the commit at 11:04; `--hot` reloads on file change and `teams.ts` was modified after the commit (my own revert at 11:09 forced a final reload from the committed content, which contains `TEAMS_HOST_WAIT_MS`). The constant cannot be read from outside the process and the real auth cannot be slowed, so the evidence is indirect: reload mechanism, file content, and 9/9 + 14/14 e2e against it with no regression. Not a separate defect.

## Findings

None new. Defects: none. Environment faults: none beyond the round-1 ones (three e2e setup steps skipped by the caller's flags, none on a teams path). D2 (NUL on routes outside the feature diff) stays a non-gating follow-up, unchanged and not re-probed.
Blocked: none.

Observation for the plan owner (not a defect, already recorded as R13 in plan.md): the deadlines in (a) projects-api `resolveClient` 5 s and (b) hours-api -> activities-api -> projects-api 2 s = 2 s nesting are outside D16 and unchanged.

## Tests added in round 2

None. Existing D16 tests (teams.test.ts, teams.budgets.cross-package.test.ts, teams.hostWait.test.ts) were sufficient: each mutation above went red in a specific test.

## Security

No new auth, input or dependency surface in round 2 (a timer and a constant export). An owasp-reviewer pass is not needed for round 2; the earlier security review (b6e12a74) stands.

## Self-critique

I could not prove the dev server's in-memory constant directly and say so; and I judged the AC-11.10 loosening by reading the spec line and the test, not by a mutation of the meetings client (I did not add a non-function export to see the static assertion fire).
