# Security review — specs/20261126-teams

- Reviewer: `wellforge:owasp-reviewer` (OWASP Top 10), dispatched by the orchestrator on the security trigger check (`--tier production --diff-base ad7a0719`, rules `auth`, `auth/**`), in parallel with QE round 0.
- Date: 2026-11-27. Scope: `git diff --name-only ad7a0719..HEAD` at that point (feature commits aa3580c7 onward; 08758806, an unrelated local-env commit, excluded).
- Frontier attention on plan § Security surfaces 2 (`GET /system/teams`) and 5 (fail-closed reasoning), as the plan requires.
- Verification: all changed backend code read; changed UI files grepped; targeted tests run against the test databases only — auth `src/teams`, `holdersOfAppAccess.contract.test.ts`, `src/system` (320 pass); projects-api `lib/teams.test.ts`, `lib/rateLimiter.test.ts`, `projects/onProject.test.ts`, `projects/teams.test.ts` (110 pass); one throwaway scratch test to confirm the NUL finding (no code modified).

## Verdict

**PASS** — 0 critical · 0 high · 0 medium · 2 low · 5 info.

## Findings and dispositions

| ID | Severity | Finding | Location | Disposition |
|---|---|---|---|---|
| S-1 | low (A04/A05) | `GET /projects?teamId=` with a NUL answers 500 (Prisma P2039, Postgres 22021) instead of 400; no data exposure, `[uncaught]` logged. Not reachable through `PUT /projects/{id}/teams` (a NUL id is dropped and answered 422 before any DB use). `projectManagerId` same, pre-existing. | `projects-api/src/lib/http.ts:123` (`IdSchema`), `projects-api/src/projects/projects.schemas.ts` | **Fixed** — QE D1, commits 05d2981b, ed8e160b: `IdSchema` refuses NUL (400 `validation_failed`); host routes unified onto it; plan amendments ad5a4f5a, 95d92e80. Re-verified by QE round 1 (626452fe). |
| S-2 | low (A04), admin only | NUL in team name, description, `{id}` or `userId` gives 500 on `/admin/teams*`; transaction rolls back inside `withAudit`. | `auth/src/teams/admin.routes.ts` | **Fixed** — same commits; a `noNul` refine on the raw value before trim. Re-verified by QE round 1. |
| S-3 | info | Page-read windows (120 per person, 2 400 per service, 10 min) can be used by ~20 insiders to degrade other people's project pages to `teamsStatus: unavailable` and `PUT …/teams` adds to 503 for up to 10 min. Decisions (activity-host, meeting-host, `/attached-teams`) use `cached`, never `admitTeamRead`, so hours bookings and assignments are not starved; auth's 600-read headroom holds. | `projects-api/src/lib/rateLimiter.ts` `admitTeamRead` | Accepted — insider-only, self-healing; optional alert on the `[teams] page-read limited` log line. |
| S-4 | info | The project view returns each attached member's `name` and `projectsAccess: false` to every `projects:access` holder (names only, no email). | `projects-api/src/projects/teamView.ts` | Accepted — the documented design (plan D10). |
| S-5 | info | `team_member.add` / `.remove` audit summaries name the member by email (Tier 2 audit log). | `auth/src/teams/admin.routes.ts` | Accepted — consistent with auth's audit log; meets AC-3.2 "naming the person". |
| S-6 | info | 409 `team_name_taken` returns `existingName`. | `auth/src/teams/nameTaken.ts` | Accepted — admin-only; admins see every team name. |
| S-7 | info | `PUT …/teams` distinguishes `team_not_found` from `team_archived`. | `projects-api/src/projects/teams.routes.ts` | Accepted — only for `project:manage` holders who already hold an opaque id. |

## Surfaces checked

1. **Admin routes `/admin/teams*`** — `requireAdmin` on every route (a department-conferred admin is refused); `baseVersion` required, compared under `SELECT … FOR UPDATE`, update names the version; the 100-member limit counted under the same row lock; `DELETE` 405; name uniqueness by bound `lower(name) = lower($1)` with the unique index as arbiter and P2002 handled; no epoch bump; teams read nowhere in `authz/` except the batch fact `holdersOfAppAccess`.
2. **`GET /system/teams`** — verify before count; RS256, issuer, `aud=SERVICE_AUDIENCE`, `system:` prefix and `teams:read` required (a user JWT fails on `aud`); `Object.hasOwn(TEAM_READERS, sub)`; one frozen 401 body, frozen 400 with no echo; allowance chosen by the presence of `ids` (`teams` 3 000 / `teamsOptions` 1 500); app derived from the verified `sub`; `ids` shape-checked (≤ 50, distinct, no duplicate keys); `q` via bound `strpos(lower(name), lower($q))`, NUL and lone surrogates refused, `%`/`_`/`\` literal; no emails returned; a deactivated member's name is `null` and ordered by id only; logs carry caller, mode, count and a search flag only; `no-store`; `holdersOfAppAccess` mirrors the resolver, pinned by a contract test.
3. **projects-api** — cache send-stamped (monotonic), ≤ 30 s fresh, ≤ 60 s only on a failed refresh, otherwise `unavailable`, never `[]`; older answers never overwrite newer; unknown/extra/duplicate/malformed items and a 401 fail closed; `redirect: "error"`, 5 s, 1 MiB cap. `PUT …/teams`: `project:manage` + entity scope + `If-Match` with CAS, ≤ 10 teams, added ids judged from a fresh non-fallback read (422 / 503 / 429), removal-only saves never call auth. `/attachable-teams` limiter counted after the guards.
4. **activities-api / hours-api** — `assignees: null` → `unavailable` → 503 `host_unavailable`, only for a changed assignee; an absent field stays `malformed`; hours-api refuses `null` before the `includes` check.
5. **Fail-closed overall** — any unreadable attached team makes `onProject` `unavailable` (activity host `assignees: null`; meeting host 503 `teams_unavailable` unless the caller is positively found on a readable team). No grant on a failed read; only the page view degrades, flagged incomplete. A removed member's stale window is ≤ 30 s normally, ≤ 60 s on an auth failure. Team membership never reaches the resolver; presence needs `active && appAccess`.
6. **UI** — no `dangerouslySetInnerHTML`, `innerHTML` or `localStorage` in the changed admin-ui and projects-ui files; team names rendered as text; calls through `apiFetch`; admin paths `encodeURIComponent`.

## Not reviewed

Live HTTP end to end (QE did that); the pre-existing use of `X-Forwarded-For` by the `/system/*` invalid-credential counter.

## Follow-up outside this feature

QE round 1 found the same NUL → 500 class on pre-existing routes (QE D2: projects-api `GET /projects?q=`, auth `POST /admin/departments`, `GET /admin/users?q=`). Not part of this feature's diff; offered to the owner as a separate bugfix, fixed once per service (a shared `noNul` helper or the global `onError` mapping P2039 to 400).
