# QE report — specs/025-projects (T19, QE-light)

Mode: **advisory, rigor `mvp`**. Blocking rows: SAST-high, lint, typecheck, security floor (secret scan over
the full git history). Advisory rows: coverage, dependency audit.
Branch `feat/projects`. Two passes are recorded here:

- **Gate pass** (2026-11-03): every unit, lint, typecheck and build row, measured at `2e4a0e8`, except
  `projects-ui`, re-run with the two QE test files added. Not re-run in the live pass: since `2e4a0e8` only
  these files changed (`git diff --name-status 2e4a0e8 HEAD`): the two QE test files, the run trace,
  `tasks.md`, this report, `projects-api/.envrc`, and the two env examples (`auth`, `projects-api`). No
  source file.
- **Live pass** (2026-11-04, measured at `39f984f`): the rows the gate pass could not run (E1, E2), against the
  developer's running stack (shell :5173, auth :3001, crm-api :8084, projects-api :8085, projects-ui :5180),
  plus the secret scan over full history, re-run.

## QE verdict: PASS (advisory mode, rigor mvp — coverage advisory)        (gates at 2e4a0e8 + QE tests; live pass and secret scan at 39f984f)

**Read first.** The live pass walked all seven requested rows, with the five test identities, and no row
failed an AC of this feature. Two findings sit outside the feature's own code and are the thing to decide on:
**D2**, the Italian copy of *every* remote (CRM included) does not reach the screen in the dev build because of
a load-order race in the shell's language seam, so AC-4.7 is proven on the catalog and on a forced
`<html lang="it">` render, not by "an Italian browser sees Italian"; and **E4**, hard page loads of any remote
crash intermittently in the dev servers (duplicate React). Neither is a defect in `projects-api` /
`projects-ui`; both are listed with their evidence below. If the caller reads AC-4.7 as "an Italian user sees
Italian", D2 makes it a FAIL until the shell is fixed — at `mvp` I rate it a suite-level finding, not a
specs/025 one, because the same screen in CRM behaves identically.

**Still not run.** (1) `bash infra/check.sh`: out of the T19 gate since the `tasks.md` amendment of 2026-11-03
(D1, resolved); it waits for provisioning. (2) Live items not walked, listed under "Live pass: not covered" below.
**Newly run:** SAST-high (semgrep, 0 findings, N2) — the gate pass had only a grep stand-in.

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
| **Security floor: secret scan, full history** (re-run in the live pass, at `39f984f`) | no secret introduced | gitleaks **8.30.1**, 822 commits / 20.72 MB: **19 findings, none a secret, none in feature code**. Triage by commit and file: 10 are dummy test-secret constants in `auth/*.test.ts` and `auth/src/test-setup.ts`; 5 are the runtime-generated key-pair variable (`kp2.privateKey`) in four `jwt.middleware.test.ts` files (inventory twice, refund, notify, estimai); 2 are `infra/check.sh` probes with a deliberately bogus credential; 1 is the truncated `MIIE...` placeholder in the `auth` env example (commit `a44f699`, older than the feature, not read this pass); **1 is new since the gate pass (the 19th): commit `a0021d1`, `specs/025-projects/qe-report.md:38`, i.e. this report's own triage prose quoting the key-pair assignment**: a false positive that I caused. This revision of the report no longer contains the literal text; the finding stays in history (no history rewrite). `main..HEAD` (26 commits) scans with that single finding and nothing else; the three T17 commits (the direnv loader and the two env examples) are inside the range and produce no finding. The repo has no gitleaks config or CI scan, so all of these are re-reported every run. | ✓ (see N1) |
| No secret-bearing file committed by the branch | none | since the gate pass T17 added or changed three files: the `projects-api` env example, the `projects-api` direnv loader, the `auth` env example: an example and a loader, committed by design. I did not read them (guard policy: no env-file reads) and rely on the gitleaks result above (no finding in them). My by-name grep of `main..HEAD` for env/key/pem files was blocked by the same guard hook and I did not work around it, so the gate pass's by-name check is not repeated | ✓ (by gitleaks; by-name check not repeated) |
| SAST-high (**executed in the live pass**; the gate pass had no tool) | none | semgrep **1.182.0** run through `mise exec` (no SAST tool is installed or configured in the repo or its CI, so this was an ad hoc run), rule packs `p/typescript` + `p/owasp-top-ten` + `p/security-audit`, severities ERROR and WARNING, `--metrics off`: **95 rules on 250 files, 0 findings (0 blocking)**, ~99.9% of lines parsed (a first run on a narrower scope: 92 rules on 159 files, 0 findings). Scope: `projects-api/src`, `projects-ui/src`, `crm-api/src/system`, `auth/src/authz`, all of `shell/src`, `tools/env-doctor`, `scripts` (every directory the branch changes source in). One parser warning, not a finding: `auth/src/authz/resolver.ts:142` ("`\u0000` was unexpected", partial parse). The gate pass's manual stand-in (grep sweep: one hit, the constant ``db.$queryRaw`SELECT 1` `` health probe; no token or secret logging) is superseded. The owasp-reviewer pass (PASS WITH NOTES, 0 critical/high/medium) was reported by the caller and is not repeated | ✓ (see N2) |
| Coverage, projects-api (advisory) | ≥80% (production floor) | 96.16% lines, 95.27% funcs (bun) | ADVISORY, above floor |
| Coverage, projects-ui / shell / auth / crm-api (advisory) | ≥80% | not measurable for projects-ui: `@vitest/coverage-v8` is not installed (`MISSING DEPENDENCY`); auth, crm-api and shell not measured (pre-existing services, only the diff changed) | ADVISORY, gap unknown |
| Dependency audit (advisory; not in the security floor per `rigor-tiers`) | — | projects-ui `pnpm audit --prod --audit-level high`: 7 high/critical (2 critical: `tinypool` via `vitest`, a test-runner transitive; same 7 in `crm-ui` on this tree, 23 in `refund-ui`). projects-api `bun audit`: 8 (3 high: `mysql2`, `deepmerge-ts`, `zod <4.6.6`; 5 moderate; 0 critical), all transitive of prisma / hono tooling or the `zod ^3` line shared with crm-api | ADVISORY (N3) |
| Mutation sample (does a test fail when the AC is violated?) | each sampled mutant killed | 22 backend mutants on a scratch copy of `projects-api` and 8 on `projects-ui`: **30/30 killed** (U7 broke the module rather than flip a behavior, so 29 are behavioral) | ✓ |
| Exploratory, live: `projects-api` smoke (gate pass) | starts, gated, CORS right | started on :8085 against the `projects` DB and the running auth: `/health` 200 with `db: ok`; `/projects` and `/scope` without token 401; garbage token 401; preflight from an allowed origin (`:5180`, set on the command line) allows `If-Match`, `PATCH` and exposes `ETag`, a non-allowed origin gets no `Access-Control-Allow-Origin`; `/openapi.json` lists all 12 paths. Server stopped, port freed. Superseded for tokens by the next row | ✓ |
| Live, `projects-api` with real user tokens (live pass) | gated per role | five identities, minted through the auth test seam: `/scope` per role is right (admin both entities and bexio, pm-it `welld_it` only, sales-ch `welld_ch` only, accounting no manage and bexio, employee 403); employee gets 403 on `/scope`, `/projects`, `/project-managers`, `/companies` and `POST /projects`; no token and a garbage token get 401 | ✓ |
| **Live, browser (Playwright MCP), row 1**: `/projects` as admin, AC-1.4 | columns, 25/page, name sort, search, filters | columns Name, Type, State, Company, Project manager, Entity; search `KOO` finds `Koordy` (case-insensitive substring); type, state and project-manager filters narrow correctly; an empty result shows "No projects match these filters"; `GET /projects` returns `pageSize: 25`, `total: 10`, sorted by name. **Not walked live: a second page** (only 10 projects exist; the page size is proven by the API field and the unit tests) | ✓ |
| **Live, row 1b**: Italian copy, AC-4.7 | Italian on screen | **With the browser locale `it-IT` the shell chrome is Italian ("Progetti", "Rimborsi", "Comprimi") but the whole projects module is English; CRM is English too** (screenshots `qe021-02`, `qe021-03`). Root cause traced: see D2. With `<html lang="it">` set before the remotes load, the module renders complete Italian on the list, the project page (details, contracts, SLA, hour package; dates and decimals through the library formatters: `10.11.2026`, `35,5 giornate`), the create dialog and the contract dialog with its validation messages (`qe021-13`, `-14`, `-15`). Only `Project manager` stays English, as in the catalog | ✓ catalog and render; ✗ delivery of the language to the remotes, suite-level (D2) |
| **Live, row 2**: create a client project, company picker vs the real CRM, move states, AC-1.1 / 1.3 / 1.6 | works | the picker called `GET /companies` (200) through the service credential and offered 3 companies, identical to `crm-api` `/companies` (3); typeahead (`bce5`) filters and a non-match shows "No company matches."; the project manager defaults to the creator ("QE021 admin (You)") and the picker lists "5 people" (module users only, the employee is absent); created `QE021 Fixed client`. States walked in the UI: planned to active, active to on_hold, Resume back to active, active to closed (only "Reopen" is offered, no Cancel), closed to active; planned to on_hold, Resume back to **planned**; planned to cancelled through a confirm ("final"), after which no state action is offered. API: cancelled to active 409 `invalid_transition` | ✓ |
| **Live, row 3**: a contract per type, no amount, who takes a contract, AC-2.x / 1.5 | every type saves, refusals hold | `fixed_price`: Start, Deadline and Max effort required (three "This field is required."), max effort 0 refused, saved with estimated 35.5. `maintenance`: neither SLA nor package refused ("Add an SLA, an hour package, or both."), SLA prefilled 1 and 3, hours 0 and 12.5 refused, saved with SLA 2/3 and a 100 h capacity package. `t_and_m`: positions required, 0 man-days refused, two positions saved. `saas`: client picker offers any CRM company, licence period start and end, saved with SLA "None" and package "None"; the project page shows "1 client" and Starts/Ends from the contract. **No amount**: no money field in any form, and a key scan of all 10 live project payloads finds no price, rate, amount, fee, budget or cost key. Refusals: internal shows "Internal projects have no contracts." and the API gives 409 `contracts_not_allowed`; closed and cancelled show no Add contract and the API gives 409 `project_not_open`; a type change away from `internal` except to `saas` gives 409 `type_change_refused`, and "Make SaaS" (with a confirm) worked. A contract: `DELETE` 405 for admin and pm-it, no delete control, "End contract" sets the end date | ✓ |
| **Live, row 4**: Bexio order id, AC-3.1 / 3.2 / 3.3 | accounting writes, others refused | accounting: the field is present and the only control on the page (no manage controls); `  BX-2026-001  ` saved trimmed and persisted after a reload; 65 characters refused ("Use at most 64 characters."); cleared; set again. pm-it and sales-ch: no input, the value shown read-only; API `PUT .../bexio-order` 403 for both, and a `PATCH` of the contract carrying `bexioOrderId` 400 (unknown key), value unchanged. Accounting `PATCH` project and `POST` project 403. Stale `If-Match` 409 with `currentVersion`, missing `If-Match` 428. AC-3.3: projects went planned, active, closed with no Bexio id | ✓ |
| **Live, row 5**: entity scoping, AC-4.4 | own entity only, controls hidden, API refuses | pm-it: the create dialog offers only `wellD IT`; created and edited an IT project; on two `welld_ch` projects (a T&M and a SaaS one, `qe021-16`) it shows **no button at all**; API `PATCH`, transition, team, `POST` contract, `PATCH` contract and `POST` project into CH: all 403 `out_of_scope`, project unchanged. Mirror, sales-ch: the dialog offers only `wellD CH`, created a CH project, has controls on CH and none on the two IT projects; API on IT: 403 `out_of_scope` x3. Both see every project in the list (AC-4.3) | ✓ |
| **Live, row 6**: employee, AC-4.1 / 4.2 | no nav entry, refused | navigation empty; `/`, `/projects` and `/projects/<id>` all land on `/no-access` ("No apps available yet", `qe021-10`); API 403 on every route; 401 with no or a garbage token. The 503-on-auth-outage half is not reproducible live without stopping auth (not done; covered by `authz-outage.test.ts`) | ✓ |
| **Live, row 7**: concurrent edit, AC-1.7 | second save refused, reload prompt | two separate browser contexts, the same admin: project "Edit details" and contract "Edit" (SLA normal days). Each time the second save was refused with the banner "This record has changed. Someone else changed this record. Reload to see their changes, then try again." and a Reload button (`qe021-11`, `qe021-12`); after Reload the first writer's value is shown and the loser's is not stored | ✓ |
| Live, keyboard and dialogs (no `design.md`; sanity only) | focus handled | New project: Enter opens the dialog, focus starts inside it, 14 Tab presses stay inside, Escape closes it and focus returns to the trigger; the cancel confirm opens with focus on "Keep project" (the safe default) | ✓ |
| Live, whole-page health in the dev stack | page renders on every hard load | **8 of 16 hard loads crashed** ("Something went wrong! Cannot read properties of null (reading 'useState')", an invalid hook call, two React copies): `/crm` 4 of 6, `/projects` 3 of 6, `/inventory` 1 of 4. Client-side navigation was never affected. Same on CRM and inventory, so not projects-specific: environment fault E4. I worked around it by reloading until the page rendered (0 to 4 retries) | ENV FAULT (E4) |
| `bash infra/check.sh` (was a T19 done-when item; amended out of the gate in `tasks.md` on 2026-11-03, commit `9f84df7`, per D1) | green | NOT RUN, deferred to provisioning. `--prereqs` alone is red here: `railway CLI missing` (E3). The projects rows probe `projects-api.operai.welld.io` / `projects.operai.welld.io`, which do not exist until provisioning (the script's own comment says they fail by design) | NOT RUN, not a gate row any more (D1 resolved) |

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
| 4.7 English and Italian; library date formatters | ✓ | `strings.test.ts` (every key has `en` and `it`, Italian is not a copy), `noHardcodedStrings.test.ts` (AST scan of every component). The date half had no guard: **QE test added** `dateFormatting.qe.test.ts` (no `toLocale*String` / `Intl.DateTimeFormat` in any source file; scanner proven able to fail; `formatDate` imported by the pages that show dates). **M** hand-rolled date: 1 fail. **Live pass:** the Italian catalog renders complete in the real app when `<html lang="it">` reaches the module (list, project page, both dialogs, library date and number formats); with an `it-IT` browser the module stays English because of D2, which is the shell's language seam and hits CRM identically | ✓ on the AC as worded; see D2 |

**Live pass (2026-11-04) per AC.** AC-1.1, 1.2, 1.3, 1.4, 1.6, 1.7, 2.1 to 2.10, 3.1 to 3.3, 4.1 to 4.6 were each
also exercised once in the running app (rows 1 to 7 in the table above); none contradicted its unit evidence.
AC-1.5 was seen on the SaaS project (Starts 01.12.2026, Ends 30.11.2027, "1 client") and on a T&M project after
"End contract" (Ends 31.12.2026); the open-ended case ("Senza scadenza" / "Open-ended") shows on the fixed-price
and maintenance projects.

Backend mutants (scratch copy `projects-api`, one at a time, targeted suite, all killed): M1–M22 as listed in
the rows above. UI mutants U1–U8 and Q1–Q7 likewise. The scratch copies were built from `git archive HEAD` and
no production file in the working tree was edited.

## Tests added by QE (tests only; no production code touched)

The live pass (2026-11-04) added no test code: it walked the running app and probed the API by hand. The two
files below are from the gate pass.

- `projects-ui/src/pages/ProjectDetailPage.scope.qe.test.tsx` (4 tests): AC-4.4, AC-3.1, AC-4.5 on the whole project
  page, both entity directions, plus a positive control that a manager does see every control. Fails under
  mutants Q1 (contract cards always editable), Q2, Q3 (Add contract ignores entity), Q4/Q5 (Bexio field wrongly
  open / wrongly hidden), Q7 (Edit team to all). The existing suite already caught Q1 and Q3 with one test each,
  so this widens the placements (contract cards, team, Bexio, both directions) rather than opening a hole.
- `projects-ui/src/lib/dateFormatting.qe.test.ts` (47 tests): AC-4.7 dates. Existing tests catch a hand-rolled
  `en-GB` date only because the expected English string differs; this guard also catches a locale-correct-in-English
  hand-rolled format, which would still be wrong in Italian.

## Defects

**D1 — RESOLVED (2026-11-03, commit `9f84df7`): T19's done-when item "`bash infra/check.sh` is green" could not
be met before production provisioning; `tasks.md` T19 was amended to take it out of the gate.** Kept for the
record. Owner: product owner / orchestrator (task wording vs `tasks.md` "Deferred"), not a dev. `tasks.md` defers
Railway/Vercel/DNS provisioning to after merge, and `infra/check.sh` probes the deployed URLs and fails the
projects rows "by design" until then (its own header, lines 64–66). Repro: `bash infra/check.sh --prereqs` is
already red locally (`railway CLI missing`); the full run would hit `projects-api.operai.welld.io`. Fix the task
(re-point the criterion to `--prereqs` plus the local gates, or move it behind provisioning), or have the owner
run it after `provision-tool`. QE did not run the full script: it issues requests to production hosts.

**D2 — The shell's language seam does not deliver the person's language to any remote in the dev build, so
projects-ui (and CRM, inventory, ...) render English for an Italian user.** New in the live pass; **missed
earlier** (the gate pass could not render Italian at all). Owner: **shell / suite-wide language seam (INC-25,
`shell/src/lib/documentLanguage.ts`, `shell/src/main.tsx`), not specs/025 and not a projects dev agent.**
Severity for this feature: AC-4.7 is satisfied as worded ("all copy exists in English and Italian", proven by
the catalog tests and by a complete Italian render with the right `lang`); the user-visible outcome is not, and
the caller may weigh it as an AC-4.7 failure (see "Read first").
Repro: sign in, open `/projects` with the browser locale `it-IT` (Playwright `locale: 'it-IT'`). The chrome reads
"Progetti / Rimborsi / Inventario / Comprimi", the module reads "Project list / New project / Fixed price".
Evidence (`.playwright-mcp/qe021-02-list-admin-it.png`, `qe021-03-detail-gcon-it.png`; trace below):
instrumenting `Element.prototype.getAttribute` for `lang` on `<html>` shows **all seven remotes (ports 5174 to
5180, projects is :5180) evaluate `selectStrings` → `resolveLocale` at t = 312 to 362 ms and read `"en"`, the
static `<html lang="en">` placeholder of `index.html`; the shell's `applyDocumentLanguage` removes that
attribute and writes `"it"` only at t = 421 ms**, so the shell is Italian and every remote is not. Control: with
`<html lang="it">` set before the page scripts run (an init script), projects-ui renders Italian everywhere I
looked. CRM, which has its own Italian catalog, behaves exactly like projects, so this is the seam and not this
feature's strings. Probably dev-only load order (federation eagerly loads the remote entries before `./locale`
runs); **I did not test a production build**, so whether Vercel behaves the same is unknown.
Suggested fix direction for the owner: do not rely on `<html lang>` having been written before a remote's module
evaluation: resolve the language lazily at render, or make `index.html` carry no placeholder / write the lang in
a blocking inline-free script before any module loads.

No code defects found in `projects-api`, `projects-ui`, `auth`, `crm-api` or the shell wiring for this feature.
No AC is wrong or untestable.

## Notes (not defects; deferred or accepted at mvp)

- **N1** Secret scan: the 19 historical findings are all false positives (one of them is this report's own prose,
  see the row above), but a `.gitleaks.toml` / `.gitleaksignore` baseline would stop them being re-triaged on
  every run (devops, separate chore).
- **N8** (product owner, wording) The cancel confirm says "A cancelled project is final: it cannot be reopened or
  changed afterwards.", yet a cancelled project still offers "Edit details" and "Edit team", and the API accepts
  `PATCH` of its name (200, I renamed `QE021 Cancel me`). AC-1.3 only makes the *state* final and the spec says
  nothing about editing a cancelled project, so this is the spec and the copy disagreeing, not a code defect:
  either forbid edits on a cancelled project or drop "or changed" from the sentence.
- **N9** (product owner, wording) A client project's company picker lists every CRM company regardless of the
  project's entity: an IT project took a `wellD CH` company. AC-1.1 requires a company, not an entity match, so it
  is correct as written; say so in the spec if it is intended.
- **N10** (dev, cosmetic) API detail strings read "A internal project cannot become fixed_price" (article).
  Not shown by the UI, which uses its own copy.
- **N11** (not feature code) The shell answers `/favicon.ico` with 404; one console error on every page, unrelated.
- **N2** SAST: there is still no SAST tool in this repo or its CI; the live pass ran semgrep once, ad hoc, through
  `mise exec semgrep@1.182.0` with registry rule packs (needs network to fetch them). Wiring `semgrep` into
  `mise.toml` / CI with a pinned rule set is what makes this row repeatable (devops, separate chore).
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
  specs/026 and 023.
- **N7** `projects-ui` has no coverage provider, so UI coverage is unmeasured at every tier until
  `@vitest/coverage-v8` is added (shell and the other UIs: not checked).

## Environment faults (not defects; no owning dev agent)

- **E1 — RESOLVED 2026-11-04.** T17 applied by the developer (service credential, direnv loader, shell variable):
  the shell serves `/projects`, the company picker reads the real CRM, and the browser reaches projects-api from
  the shell's origin. Was: T17 not applied.
- **E2 — RESOLVED 2026-11-04.** Test identities seeded by the developer (`qe021-admin`, `-pm-it`, `-sales-ch`,
  `-accounting`, `-employee`, local only, minted through the auth test seam). The rows E2 listed were all run:
  see the live rows above.
- **E3** `railway` CLI is not installed on this machine, so `infra/check.sh --prereqs` is red for reasons unrelated
  to the feature. Unchanged.
- **E4 — NEW (live pass).** Intermittent crash of hard page loads in the dev stack: "Something went wrong! Cannot
  read properties of null (reading 'useState')", React console error "Invalid hook call ... more than one copy of
  React" with the stack in `ProjectsShell` → `useResource` (projects-ui :5180, `react.js?v=...`) running under the
  shell's `react-dom_client.js?v=...`. Checked: it reproduces on `/crm` (4 of 6 loads) and `/inventory` (1 of 4) as
  well as `/projects` (3 of 6), in a cold browser context and with the HTTP cache cleared, and **never** on
  client-side navigation or after a successful load; so it is the dev federation / Vite dependency pre-bundling
  sharing of React across seven dev servers racing at startup, not the projects module. No stale-cache,
  stored-session or service-worker cause found (localStorage held only the theme and last tool; no service worker).
  An earlier symptom in this pass (the Playwright browser closing mid-run) was also seen once and not
  investigated. Owner: whoever owns the dev federation setup (shell / `mise run dev`); not a specs/025 dev agent.
  A production build was not tested. Workaround used here: reload until the page renders.
- **E5** (QE tooling, for the next agent) The Playwright default context is shared and persistent; I used the
  default context for single-identity steps (cookie swapped per identity) and fresh `browser.newContext()`
  contexts for the Italian pass and for the two-context concurrency row. Screenshots go to the repo's
  `.playwright-mcp/` folder (untracked, not committed).

## Live pass: not covered (deferred, none blocks the verdict at `mvp`)

- A **second page** of the list (25 per page): only 10 projects exist. Proven by `pageSize: 25` in the API and the
  unit tests.
- The **503 on an auth outage** (AC-4.2): would need auth stopped, which the caller forbade. Unit-covered.
- A **yearly** hour package, an hour package with an expiry date, and the **team picker in the UI** (team writes
  were checked through the API: 422 for a person without access, 200 for one with). Unit-covered.
- The UI reload banner for a **Bexio** write and for a **team** write (the API gives 409 with `currentVersion` and
  428 without `If-Match`; the project and contract banners were seen live).
- A **production build** (language seam, React sharing): not run, see D2 and E4.
- Responsive widths, dark theme (the shell had stored "dark"; the pages rendered, not inspected), screen-reader
  output.

## Live pass (2026-11-04)

Run by the quality-engineer agent against the developer's stack, no process started, stopped or restarted.
Identities minted through `POST :3001/test-auth/session`; the cookie was injected into a Playwright browser
context per identity (and cleared between identities). HEAD at the time of the pass: `39f984f`; this report is
the only file the pass commits.

**QE021 records created** (all named with the prefix; the project module has no project delete, so removal is by
database). Projects, with ids:

| Id | Name now | Type / state / entity | Contract id (Bexio) |
|---|---|---|---|
| `cmw1uhovv0002f0vdp624en9r` | QE021 Fixed client | fixed_price / active / welld_it | `cmw1uirbl0003f0vd90ph39qt` (`QE021-ORDER-8`) |
| `cmw1uoe780004f0vdqwtxotko` | QE021 Maintenance client | maintenance / planned / welld_it | `cmw1urlfh0009f0vdv2ljpdp0` (none) |
| `cmw1uoy4z0005f0vdjunevzz5` | QE021 TnM client | t_and_m / planned / welld_ch | `cmw1urxk8000af0vdrdfwny0q` (none; ended 31.12.2026) |
| `cmw1upd7k0006f0vd3ks78blf` | QE021 SaaS product | saas / planned / welld_ch | `cmw1usad4000df0vdugwmngvk` (none) |
| `cmw1upiy90007f0vd86un6ejp` | QE021 Internal tool B-edit | internal / planned / welld_it | none |
| `cmw1uptl80008f0vdwxbyjqcg` | QE021 Cancel me (renamed) | t_and_m / cancelled / welld_it | none |
| `cmw1uueu0000ef0vdxd89wdwj` | QE021 PM-IT internal (edited) | internal / planned / welld_it | none (team: `qe021-pm-it`) |
| `cmw1uv7ky000ff0vdz8tofkaw` | QE021 Sales-CH internal | saas (made SaaS) / planned / welld_ch | none |

The developer's two projects (`GCON`, `Koordy`) were read and filtered but never written. The five `qe021-*` users
were seeded by the developer and are left as they were (each session-seam call I made passed the display name
"QE021 <role>"). Evidence screenshots are on disk, untracked, in `.playwright-mcp/`:
`qe021-01-list-admin-en.png`, `-02-list-admin-it.png`, `-03-detail-gcon-it.png`, `-04-fixed-contract-admin.png`,
`-10-employee-refused.png`, `-11-concurrent-A.png`, `-12-concurrent-contract-A.png`,
`-13-list-italian-forced-lang.png`, `-14-detail-fixed-italian.png`, `-15-contract-dialog-italian.png`,
`-16-pm-it-on-ch-project-no-controls.png`, `-17-accounting-bexio-field.png`.

## Recommendations

- `owasp-reviewer`: already run (PASS WITH NOTES). The live pass saw nothing that changes that: the service
  credential is only reachable through `GET /companies`, which an employee gets 403 on and which returned the same
  3 companies as the CRM. Re-run only if the `SERVICE_CLIENTS` scope changes.
- Route **D2** to the shell owner (and decide whether it blocks AC-4.7 for you); route **E4** to whoever owns the dev
  federation setup. Neither needs a specs/025 dev agent.
- **D1** is resolved by the `tasks.md` amendment. T19's remaining done-when is the verdict plus
  `/wellforge:done 025-projects`; I do not touch `tasks.md` or the spec status.
- The developer can remove the QE021 rows listed above; nothing else in the database was created by this pass.
