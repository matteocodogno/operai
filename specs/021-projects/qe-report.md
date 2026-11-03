# QE report — specs/021-projects (T19, QE-light)

Mode: **advisory, rigor `mvp`**. Blocking rows: SAST-high, lint, typecheck, security floor (secret scan over
the full git history). Advisory rows: coverage, dependency audit.
Branch `feat/projects`. All gates below measured at `2e4a0e8`, except `projects-ui`, re-run with the two QE
test files added (commit that carries this report; `git diff --stat 2e4a0e8 HEAD` is these two test files plus
this report, nothing else).

## QE verdict: PASS (advisory mode, rigor mvp — coverage advisory)        (measured at 2e4a0e8 + QE tests)

**Not run, stated first.** (1) Every live-app row: `projects-api` was started for a smoke probe, but the
signed-in browser pass, the shell with the projects remote, and the company picker against the real CRM could
not run — T17 (local env) is open: no `SERVICE_CLIENTS` entry for `projects-api` in auth, no
`projects-api/.envrc`, no `VITE_PROJECTS_API_URL` in the shell, and no test identity I may use. Recorded as an
environment fault; at `mvp` QE-light does not need those rows. (2) `bash infra/check.sh`, a T19 done-when
item: see Defect D1 — it cannot be green before provisioning.

| Check | Threshold | Actual | Result |
|---|---|---|---|
| AC coverage (spec US-1..US-4) | 27/27 ACs with a test that fails when violated | 27/27 (table below); two gaps narrowed by QE tests (AC-4.4 contract-level hiding, AC-4.7 dates); 17 of 27 ACs also sampled by mutation (marked **M** below; the other 10 rest on the named tests, which I read but did not mutate) | ✓ |
| auth tests | green | 630 pass / 0 fail (47 files) | ✓ |
| auth typecheck | clean | `tsc --noEmit` exit 0 | ✓ |
| crm-api tests | green | 262 pass / 0 fail (21 files) | ✓ |
| crm-api typecheck | clean | exit 0 | ✓ |
| projects-api tests | green | 569 pass / 0 fail (14 files) | ✓ |
| projects-api typecheck | clean | exit 0 | ✓ |
| projects-api build (`bun run build`) | bundles | 186 modules, 5.54 MB, exit 0 | ✓ |
| projects-ui lint | clean | `eslint .` exit 0 (re-run with QE tests) | ✓ |
| projects-ui build | clean | exit 0 (re-run with QE tests) | ✓ |
| projects-ui tests | green | 308 pass / 0 fail (16 files; 257 dev + 51 QE) | ✓ |
| shell lint | clean | exit 0 | ✓ |
| shell build | clean | exit 0 (two federation `IMPORT_IS_UNDEFINED` warnings, for `@tanstack/react-router` and `better-auth` default imports in the shared-module prebuild; same pattern for every remote, none names projects) | ✓ |
| shell tests | green | 305 pass / 0 fail (31 files) | ✓ |
| env-doctor (`bun test tools/env-doctor`) | green | 137 pass / 0 fail | ✓ |
| shared copies (`bun scripts/check-shared-copies.ts`) | exit 0 | 1 group in sync (serviceToken), exit 0 | ✓ |
| changeset (`check-changeset.mjs --base=main --head=HEAD`) | OK | OK, matched `.changeset/projects-tool.md` | ✓ |
| Migration applied | up to date | `prisma migrate status` on `projects`: "Database schema is up to date" (1 migration) | ✓ |
| **Security floor: secret scan, full history** | no secret introduced | gitleaks **8.30.1**, 818 commits / 20.68 MB: **18 findings, none in this feature**: the 22 commits of `main..HEAD` scan clean ("no leaks found"). All 18 are in older commits and triaged as non-secrets: 10 are dummy test-secret constants (`dummy-routes-…`, `dummy-secret-A…`, `test-secret-th…`), 5 are `otherPrivateKey = kp2.privateKey` (a key pair generated at runtime in four `jwt.middleware.test.ts` files), 2 are `infra/check.sh` probes with a deliberately bogus credential (`not-a-real-secret`, `not-the-real-token`), 1 is the `auth/.env.example` placeholder `JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END..."` (truncated, not a key). The repo has no gitleaks config or CI scan, so these are reported every run. | ✓ (see N1) |
| No env/key files committed by the branch | none | `git diff --name-only main..HEAD` lists no env, key or pem file | ✓ |
| SAST-high | none | **No SAST tool is installed or configured** (`semgrep`/`opengrep` not on PATH, none in repo CI): the tool row did not run. Compensating checks, which are not a substitute: grep sweep of `projects-api/src`, `projects-ui/src`, `crm-api/src/system` for `eval`, `new Function`, `child_process`, `Bun.spawn`, `innerHTML`, `dangerouslySetInnerHTML`, raw SQL: one hit, ``db.$queryRaw`SELECT 1` `` (constant health probe). No token/secret logging. The owasp-reviewer pass (PASS WITH NOTES, 0 critical/high/medium) was reported by the caller and is not repeated. | ✓ (see N2) |
| Coverage, projects-api (advisory) | ≥80% (production floor) | 96.16% lines, 95.27% funcs (bun) | ADVISORY, above floor |
| Coverage, projects-ui / shell / auth / crm-api (advisory) | ≥80% | not measurable for projects-ui: `@vitest/coverage-v8` is not installed (`MISSING DEPENDENCY`); auth, crm-api and shell not measured (pre-existing services, only the diff changed) | ADVISORY, gap unknown |
| Dependency audit (advisory; not in the security floor per `rigor-tiers`) | — | projects-ui `pnpm audit --prod --audit-level high`: 7 high/critical (2 critical: `tinypool` via `vitest`, a test-runner transitive; same 7 in `crm-ui` on this tree, 23 in `refund-ui`). projects-api `bun audit`: 8 (3 high: `mysql2`, `deepmerge-ts`, `zod <4.6.6`; 5 moderate; 0 critical), all transitive of prisma / hono tooling or the `zod ^3` line shared with crm-api | ADVISORY (N3) |
| Mutation sample (does a test fail when the AC is violated?) | each sampled mutant killed | 22 backend mutants on a scratch copy of `projects-api` and 8 on `projects-ui`: **30/30 killed** (U7 broke the module rather than flip a behavior, so 29 are behavioral) | ✓ |
| Exploratory, live: `projects-api` smoke | starts, gated, CORS right | started on :8085 against the `projects` DB and the running auth: `/health` 200 with `db: ok`; `/projects` and `/scope` without token 401; garbage token 401; preflight from an allowed origin (`:5180`, set on the command line) allows `If-Match`, `PATCH` and exposes `ETag`, a non-allowed origin gets no `Access-Control-Allow-Origin`; `/openapi.json` lists all 12 paths. **Not exercised with a real user token** (no test identity). Server stopped, port freed. | ✓ (partial) |
| Exploratory, live: browser, signed-in flows, company picker vs CRM | walked | NOT RUN, environment fault (T17 open) | NOT RUN (env fault) |
| `bash infra/check.sh` (T19 done-when) | green | NOT RUN, see D1. `--prereqs` alone is red here: `railway CLI missing`. The projects rows probe `projects-api.operai.welld.io` / `projects.operai.welld.io`, which do not exist until provisioning (the script's own comment says they fail by design) | NOT RUN (D1) |

No `design.md` exists for this feature, so there are no design-state or accessibility rows.

## Per-AC verdict

"Evidence" is the test that fails when the AC is violated (a mutation I applied and watched fail is marked
**M**). API tests drive the assembled app in-process with the live-resolve fake of auth; UI tests drive the real
router against a fake projects-api.

| AC | Result | Evidence |
|---|---|---|
| 1.1 create (name, type, entity, PM default caller; company iff client type) | ✓ | `projects-api/src/projects/projects.test.ts` POST block (company_required / _not_allowed / _not_found, PM defaults, out_of_scope); `projects-ui/.../ProjectFormDialog.test.tsx` company field per type. **M** (PM access check removed: 3 fail) |
| 1.2 type change refused except internal → saas | ✓ | `transitions.test.ts` every type pair, `type_change_refused`; UI "Make SaaS" on internal only. **M** UI always-offered: 11 fail |
| 1.3 states and moves | ✓ | `transitions.test.ts` full 5×5 matrix, on_hold returns to the state it left, cancelled final; UI `ProjectDetailPage.test.tsx` "offers only its allowed moves" per state. **M** closed→cancelled: 1 fail; on_hold back-anywhere: 8 fail; Resume→planned: 1 fail |
| 1.4 list: columns, 25/page, name sort, search, filters | ✓ | `projects.test.ts` GET /projects (pages by 25, sorted, case-insensitive search, type/state/PM filters, clientCount), `GET /project-managers`; `ProjectsPage.test.tsx` columns, "N clients", "Internal", filters. **M** page size 26: 3 fail; search case-sensitive: 2 fail; PM filter dropped: 1 fail; clientCount by contracts: 1 fail |
| 1.5 project page: details, contracts, team, derived dates | ✓ | `projects.test.ts` GET /projects/:id and "derived dates"; `ProjectDetailPage.test.tsx`. **M** open-ended handling: 2 fail. See N4 on the open-ended reading |
| 1.6 PM and team must hold module access | ✓ | `projects.test.ts` + `team.test.ts` (422 `not_project_user` naming ids, live check, 503 when auth cannot answer, never an allow); UI pickers list module users only (`?appId=projects`). **M** team check removed: 3 fail |
| 1.7 concurrent edit refused, reload asked | ✓ | 428 / 409 / "one of two wins" tests on PATCH project, transitions, type, team, contract PATCH, Bexio PUT; UI reload banner on 409 and 428 for project, team, contract, Bexio |
| 2.1 contract shows company, origin, Bexio id, start, end | ✓ | `contracts.test.ts` create/read; `ContractCard.test.tsx` |
| 2.2 who takes a contract | ✓ | `contracts.test.ts` internal 409, closed/cancelled 409 `project_not_open`, `company_mismatch`, saas any company; UI "Add contract" rules. **M** API closed accepted: 2 fail; UI closed accepted: 2 fail |
| 2.3 fixed price | ✓ | BAD table (no deadline, no max effort, zero, two decimals, negative estimate); DB CHECK in `db.constraints.test.ts`; UI form |
| 2.4 maintenance needs SLA or hours | ✓ | `maintenance_needs_sla_or_hours` 422 on create and on stripping by PATCH; UI cannot save. **M** API: 2 fail; UI: 2 fail |
| 2.5 SLA whole days, prefilled 1/3 | ✓ | BAD table (61, negative, fractional, one priority); UI "prefilled with 1 and 3 days". **M** max 61: 1 fail; UI prefill 2/4: 3 fail |
| 2.6 hour package | ✓ | BAD table (zero, fractional, unknown kind, no start, yearly with expiry, expiry before start); DB CHECKs. **M** `>0`→`>=0`: 1 fail |
| 2.7 T&M positions | ✓ | BAD table (none, zero days, blank/over-long profile); `positions` replaced in order. **M** min(1) removed: 2 fail |
| 2.8 saas licence period, optional SLA/hours | ✓ | `contracts.test.ts` "SaaS contract … neither SLA nor hours"; `ContractFormDialog.test.tsx` SaaS |
| 2.9 no amount, price, rate | ✓ | API: key scan of every contract type and the project page for money-named keys (non-vacuous), and `price` in a body is a 400; UI: form has none; no money column in the Prisma schema |
| 2.10 contract never deleted; ends by end date | ✓ | `DELETE` → 405 `not_deletable` for pm/admin/viewer, DB restricts via project delete; UI has no delete control, "End contract" PATCHes `endDate`. **M** 405→200: 3 fail |
| 3.1 only `contract:bexio` writes the Bexio id | ✓ | `bexio.test.ts` (accounting yes; pm, sales, viewer, colleague 403; admin yes); `/scope` carries `bexio`; UI field read-only without it. **M** route open: 11 fail; `/scope` bexio always true: 4 fail; UI field open to all: 4 fail (+2 with QE tests) |
| 3.2 free text ≤64, trimmed, unchecked | ✓ | 64 ok / 65 → 400, trim, blank → null, duplicates allowed. **M** 65: 1 fail; no trim: 2 fail |
| 3.3 missing id never blocks | ✓ | `bexio.test.ts` planned → active → closed with no id; create without id |
| 4.1 module appears only for `projects:access` | ✓ | `shell/src/router.projects.test.tsx` (route guard, `/no-access`, sidebar entry only when granted, `crm:access` does not stand in), `tools.test.ts` |
| 4.2 no access 403; auth outage 503, never allow | ✓ | `matrix.test.ts` outsider column, `authz-outage.test.ts`, 503 on identity checks; UI `ProjectsShell.test.tsx` "503 never an empty scope". **M** fail-open on outage: 16 fail |
| 4.3 every access holder reads everything | ✓ | matrix `viewer` persona reads every GET on both entities |
| 4.4 entity-scoped manage; controls hidden | ✓ | matrix (own entity ok, other `out_of_scope`, none `forbidden`, DB unchanged on refusal); auth `seed.test.ts` (entity condition on `project-manager` and `sales`). UI hiding for the other entity was proven only for project-level controls: **QE test added** `ProjectDetailPage.scope.qe.test.tsx` (both entity directions: no Add contract / Edit / End contract / Edit team / Edit details / Make SaaS). **M** assertCanManage no-op: 21 fail; UI entity scope always true: 9 fail |
| 4.5 `accounting`: access + Bexio, no new role | ✓ | `seed.test.ts` accounting = `projects:access` + `contract:bexio`, nothing else; matrix; QE test: accounting sees the Bexio field and no manage control on either entity |
| 4.6 admin unscoped, employee nothing | ✓ | `seed.test.ts` admin three grants unconditioned, employee zero; matrix `admin` and `outsider` |
| 4.7 English and Italian; library date formatters | ✓ | `strings.test.ts` (every key has `en` and `it`, Italian is not a copy), `noHardcodedStrings.test.ts` (AST scan of every component). The date half had no guard: **QE test added** `dateFormatting.qe.test.ts` (no `toLocale*String` / `Intl.DateTimeFormat` in any source file; scanner proven able to fail; `formatDate` imported by the pages that show dates). **M** hand-rolled date: 1 fail. Italian was not rendered in a browser |

Backend mutants (scratch copy `projects-api`, one at a time, targeted suite, all killed): M1–M22 as listed in
the rows above. UI mutants U1–U8 and Q1–Q7 likewise. The scratch copies were built from `git archive HEAD` and
no production file in the working tree was edited.

## Tests added by QE (tests only; no production code touched)

- `projects-ui/src/pages/ProjectDetailPage.scope.qe.test.tsx` (4 tests): AC-4.4, AC-3.1, AC-4.5 on the whole project
  page, both entity directions, plus a positive control that a manager does see every control. Fails under
  mutants Q1 (contract cards always editable), Q2, Q3 (Add contract ignores entity), Q4/Q5 (Bexio field wrongly
  open / wrongly hidden), Q7 (Edit team to all). The existing suite already caught Q1 and Q3 with one test each,
  so this widens the placements (contract cards, team, Bexio, both directions) rather than opening a hole.
- `projects-ui/src/lib/dateFormatting.qe.test.ts` (47 tests): AC-4.7 dates. Existing tests catch a hand-rolled
  `en-GB` date only because the expected English string differs; this guard also catches a locale-correct-in-English
  hand-rolled format, which would still be wrong in Italian.

## Defects

**D1 — T19's done-when item "`bash infra/check.sh` is green" cannot be met before production provisioning.**
Owner: product owner / orchestrator (task wording vs `tasks.md` "Deferred"), not a dev. `tasks.md` defers
Railway/Vercel/DNS provisioning to after merge, and `infra/check.sh` probes the deployed URLs and fails the
projects rows "by design" until then (its own header, lines 64–66). Repro: `bash infra/check.sh --prereqs` is
already red locally (`railway CLI missing`); the full run would hit `projects-api.operai.welld.io`. Fix the task
(re-point the criterion to `--prereqs` plus the local gates, or move it behind provisioning), or have the owner
run it after `provision-tool`. QE did not run the full script: it issues requests to production hosts.

No code defects found. No AC is wrong or untestable.

## Notes (not defects; deferred or accepted at mvp)

- **N1** Secret scan: the 18 historical findings are all false positives, but a `.gitleaks.toml` /
  `.gitleaksignore` baseline would stop them being re-triaged on every run (devops, separate chore).
- **N2** SAST: there is no SAST tool in this repo. At `mvp` the SAST-high row is therefore a manual stand-in
  (owasp-reviewer plus the grep sweep above). Wiring `semgrep` is the way to make this row mean something.
- **N3** Dependency audit: nothing here is new to this feature (`projects-ui` copies `crm-ui`'s dependency set;
  `projects-api` copies `crm-api`'s). The criticals are `tinypool` under `vitest` in the test runner, never in the
  shipped bundle. A suite-wide `vitest` bump clears them (devops chore). `projects-api` carries `zod ^3.24`
  (GHSA-mrhx-c7xc-m3w5, oversized-collection memory use); the 64 KiB body limit bounds it.
- **N4** AC-1.5 reads "the latest contract end"; the build returns `endDate = null` when any contract is
  open-ended (decided in `tasks.md` "Derived dates", tested, shown as "Open-ended" in the UI). Defensible, and
  the spec could say so in one line (product owner, wording only).
- **N5** `projects-api/src/authz/conditions.ts`: 63.9% line coverage; `findPermission` and `inScope` are copied
  from crm-api and unused here. Dead copy, harmless.
- **N6** Deferred by `tasks.md` and unchanged: shell e2e journey for `/projects`, production provisioning,
  specs/022 and 023.
- **N7** `projects-ui` has no coverage provider, so UI coverage is unmeasured at every tier until
  `@vitest/coverage-v8` is added (shell and the other UIs: not checked).

## Environment faults (not defects; no owning dev agent)

- **E1** T17 not applied (when applying it: the browser calls projects-api from the **shell's** origin, so `ALLOWED_ORIGINS` must include `:5173`, not only the remote's `:5180`): no `projects-api/.envrc`, no `SERVICE_CLIENTS` entry for `projects-api` in auth, no
  `VITE_PROJECTS_API_URL` in the shell, so `mise run dev` cannot serve `/projects`. The stale
  `projects-api/.env` (PORT 8084) is a pre-existing local file and was not read or changed; the smoke probe set
  its variables explicitly on the command line and stopped the process afterwards.
- **E2** No test identity for a signed-in browser pass (the guard hook blocks env files; no seeded user was handed
  over). Re-run QE for the live rows only once T17 is applied and a user is seeded:
  `/projects` list, create (company picker against the real CRM through the service credential), a contract per
  type, Bexio as `accounting`, entity-scoped refusal as `project-manager` / `sales`, Italian copy.
- **E3** `railway` CLI is not installed on this machine, so `infra/check.sh --prereqs` is red for reasons unrelated
  to the feature.

## Recommendations

- `owasp-reviewer`: already run (PASS WITH NOTES); no further pass needed for this verdict. Re-run if T17 changes
  the service-credential scope or the `SERVICE_CLIENTS` handling.
- Next: apply T17, seed a test user, then a short live QE pass (E2 list). T19 stays unchecked here; the
  orchestrator closes it after D1 is resolved.
