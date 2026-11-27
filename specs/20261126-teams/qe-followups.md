# QE of the follow-ups to specs/20261126-teams (R12, R13, D2)

This file holds two passes: **Round 1** (re-verification after the fix round, below) and **Round 0** (the first pass, kept as it was, further down).

## Round 1: re-verification of the fix round

Measured at `af6eb6d1` plus my own additions (one test file and the sweep script, see "Tests added in round 1"). Full mode (rigor production).
Backend suites ran on `*_test` databases only, clean env (`env -i`), foreground; the live sweep ran on the dev stack (HMR) with a session minted by the e2e helpers.
No migration and no test was run on a dev database; the only dev-database reads were two `count(*)` on `_prisma_migrations` (refund, crm).

## QE verdict: FAIL        (measured at af6eb6d1)

The four items of round 0 are **closed**: F1 (refund, estimai, notify), F2 (projects `q`), F3 (meetings test) and E6 (global setup). One new defect, **F4**,
turned up in the wider sweep: crm-api `PUT /deals/{id}/offer-draft` answers 500 for a date that is not a calendar date. It is not a NUL defect and not a
regression of the fix round (it dates from the wizard, `33ebd929`, and the zod 4 migration). My round-0 sweep saw that 500 and filed it as "worth a look" without
isolating it: it was **missed earlier**. Nothing is BLOCKED. If F4 is split off as a separate bug, the follow-ups themselves pass.

| Check | Threshold | Actual | Result |
|---|---|---|---|
| Live probe that each fix is loaded (dev stack) | each answers 400 | refund `GET /requests/a%00b` and `/export` 400; estimai `/estimates/a%00b` and `/collaborators` 400; notify `/notifications?cursor=a%00b` 400; projects `/companies?q` and `/queue?q` 400 (control `q=ab` 200) | ✓ |
| D2 sweep, all 11 services, every documented operation x one NUL at a time (query, path, up to 80 body leaves, arrays with a second element), plus all leaves at once and a NUL in an unknown key | 0 5xx whose control is not a 5xx | auth 203 requests (0 5xx), estimai 103, notify 14, refund 93, inventory 80, meetings 205, projects 75, activities 66, accounting 31, hours 54 (all 0 5xx); crm 293 (no NUL-specific 5xx; F4 and E8 aside) | ✓ (F4 apart) |
| The 12 requests of F1 (round 0) | 400 | all 12 now 400, no value echoed | ✓ |
| `/system/*` of every service with a user token (new in this round) | identical 401 before parsing, 0 5xx | estimai 4, notify 14, crm 16, meetings 2, projects 1, activities 25, accounting 3 requests: all 401; auth 7: all 400 (its global guard refuses the NUL before credentials; reveals nothing about them) | ✓ |
| `/system/*` behind a VALID service credential | NUL is a 400 | not probeable live (no service secret may be read). Read in code: crm companies/contacts/deals `hasNoNul`/`searchText`; projects purchase-orders `hasNoNul`; estimai summary `IdSchema`; activities `idText()` and `noNul`; meetings hosts `queryable()` drops a NUL id; accounting checks the entity before any read and `pairs` by pattern; notify schemas moved to `nulInput`. Not executed | ✓ by reading only (see self-critique) |
| auth `bun test` (operai_auth_test) + typecheck | 0 fail | 1728 pass, 0 fail; tsc exit 0 | ✓ |
| projects-api | 0 fail | 1539 pass, 0 fail; tsc 0 | ✓ |
| refund-api (refund_test) | 0 fail | 2391 pass, 0 fail (my 2 `it.failing` are plain tests now and pass); tsc 0 | ✓ |
| estimai-api (estimai_test, AUTH_DATABASE_URL = operai_auth_test with the real credentials) | 0 fail | 454 pass, 0 fail (E5 gone); tsc 0 | ✓ |
| notify-api (notify_test) | 0 fail | main tree 713 pass + 6 fail (E2, child-boot tests); clean worktree of HEAD with placeholder env: 730 pass, 0 fail; tsc 0 | ✓ (E2) |
| meetings-api (meetings_test), **twice** (F3) | 0 fail both times | run 1: 2024 pass, 0 fail; run 2: 2024 pass, 0 fail; tsc 0 | ✓ |
| crm-api (crm_test) | 0 fail | 2430 pass + 1 fail (E1, child boot); the failing file alone in a clean HEAD worktree: 32 pass, 0 fail; tsc 0 | ✓ (E1) |
| activities-api, accounting-api, inventory-api | 0 fail | 846/0, 674/0, 914/0; tsc 0 for all | ✓ |
| hours-api (hours_test) | 0 fail | 1903 pass + 1 fail = `env.test.ts` (E4, the user's direnv file); tsc 0 | ✓ (E4) |
| `scripts/check-shared-copies.ts` | in sync | 37 groups in sync | ✓ |
| `scripts/check-single-replica.ts` + `scripts` tests | exit 0 | "5 services, each exactly 1 replica"; 68 pass, 0 fail | ✓ |
| `tools/env-doctor` tests, `mise run env:doctor` | 0 fail | 300 pass, 0 fail; "all checks passed" | ✓ |
| e2e teams (4 specs) with `E2E_SKIP_REFUND_ACCOUNTING_RELEASE=1`, no `POSTGRES_*` exported | all pass | 23 passed (1.4 min); log: "accounting seeded (done)", "legal-entity registry in order: welld_it v2, welld_ch v2" | ✓ |
| e2e with **no** `E2E_SKIP_*` | completes | stops at the refund release, step `propose`, Prisma P2022: refund dev database has 7 of 17 migrations. The two round-0 causes of E6 are fixed: `ACCOUNTING_INTERNAL_URL` is passed and the legal-entities step needs no exported credentials | environment (E7), not a defect |
| Mutations of the fixes, each seen red | red | refund: schema refusal off 3 fail, `runExit` rethrow off 4 fail; estimai: refusal off 12 fail; notify: refusal off 11 fail; projects: `q` back to `z.string()` on companies and queue, 2 fail (the two new tests); all restored | ✓ |
| crm wizard answers: a date that is not a calendar date | 422 `answers_invalid` | `PUT /deals/x/offer-draft` with `client.date` = `"x"` or `"2026-13-45"`: **500** `Invalid Date` (control `2026-01-01` answers 422 for another member, `2026-02-30` answers 422 `Not a calendar date`) | ✗ F4 |

## Defects

**F4. `AnswersSchema` throws on an invalid date; the wizard answers a 500** (owner: backend-dev crm-api; severity low: caller input only, no data exposure; pre-existing, **missed earlier**).
Root cause: `crm-api/src/offer-drafts/answersSchema.ts` `realDate` is a `regex(/^\d{4}-\d{2}-\d{2}$/)` followed by
`refine((v) => new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), "Not a calendar date")`. `toISOString()` throws `RangeError: Invalid Date` for an
Invalid Date, so the refinement that should answer "Not a calendar date" raises instead; under zod 4 the refinement also still runs after the regex failed,
so `"x"` throws as well as `"2026-13-45"` (which passes the regex). `2026-02-30` is the only impossible date that works, because JS rolls it over.
Placements of the same schema: `PUT /deals/{id}/offer-draft` ✗ (live 500, 3 inputs); `AnswersSchema` unit ✗ (RangeError for `x`, `2026-13-45`, `2026-00-10`);
`POST /deals/{id}/offer-draft/preview` and `POST /offer-templates/{id}/try-preview`: not reachable on this stack (404 "does not exist": not mounted while the letterhead switch is off), same schema by code, not executed;
stored drafts: `parseStoredAnswers` uses `safeParse` on the same schema, so reading a draft with such a date would throw too, but the write refuses it only once F4 is fixed (no such draft can exist: the write 500s today).
Failing test: `crm-api/src/offer-drafts/answersSchema.date.qe.test.ts` (3 `it.failing`, each seen to fail as a plain test with `RangeError: Invalid Date`; remove `.failing` with the fix).
Fix shape for the dev agent: the refinement must not throw (test `Number.isNaN(new Date(...).getTime())` first), and not run on a string the regex refused.

No other defect. Every placement of F1, F2 and F3 is in the table; none is new since the fix.

## Info (no verdict effect)

- Zod "Unrecognized key" messages quote the unknown key name, JSON-escaped (`\u0000`), in `detail` and `errors` on 9 services (every strict body). It is the caller's own text in a 4xx, never stored; auth's global guard answers 400 before that, so auth is the odd one out. D2's "no echo" (plan.md line 70) is written for values (`detail`, `errors`, `field`), so I did not file it; say so if the rule is meant to cover key names.
- estimai and notify answer a path/query NUL with the pre-existing `{ success: false, error: { issues, name } }` shape (`src/lib/zodHook.ts`, pinned by its own tests), not a Problem JSON; body-level ones are Problem JSON. Designed, unchanged.
- 404 bodies that quote the path for a NUL id remain on crm (`POST /offer-templates/{id}/try-preview`, `POST /deals/{id}/offer-draft/preview`); the refund request routes no longer do.
- `accounting-api/scripts/seed-welld-ch.ts`: `export const USAGE ="Usage:` (missing space), cosmetic, from round 0.

## Environment faults (not defects, no fix round)

- E1, E2, E4 as in round 0: crm and notify child-boot tests pick up the gitignored dotenv of the working directory (green in a clean HEAD worktree: crm file 32/32, notify 730/0); hours `env.test.ts` is the user's direnv file still naming `meetings`.
- E5 resolved by giving estimai's test run the real auth-test credentials (454/0).
- E7. The refund dev database is behind: 7 of 17 migrations applied (`mise run db:migrate`, the user's step). It is the one remaining step of the e2e global setup with no skip flag. The crm dev database is behind too: 14 of 20.
- E8. Dev-stack processes look stale or hot-reloaded across a client change, which produced 500s on controls with no NUL: crm `GET /companies`, `/deals` (`company.kind`, `deal.fileCode` do not exist: E7's cause); crm `GET /pipeline` (`syntax error at or near "$1"`: a `Prisma.empty` fragment inside `$queryRaw`, which is green in `crm_test`, 2430 tests, so a class-identity effect of hot reload is the likely cause rather than the code); auth `POST /admin/departments` and `/admin/roles` with a duplicate name (500 with Prisma text instead of 409: the `instanceof PrismaClientKnownRequestError` guard; its test in `departments.routes.test.ts` passes with 409); refund `GET /accounting/expense-type-defaults` and `/receipt-codes` (`undefined is not an object (evaluating 'client.expenseTypeAccountingDefault.findMany')`: a Prisma client generated before those models existed); auth `GET /.well-known/jwks.json` (`"spki" must be SPKI formatted string`: key configuration); projects `GET /queue` (503, crm cannot answer). Re-probe after the user runs `mise run db:migrate` and restarts `mise run dev`. I could not test the hot-reload explanation without a restart: if any of these still answers 500 on a fresh stack it becomes a defect.
- Left on the shared dev Postgres by me: the users `qe-followup-probe`, `qe-vis-creator`, `qe-vis-other` (@operai.test) and the empty database `qe_unmigrated_test` (round 0). The sweep's own `x` department and `x` role in auth were deleted at the end of this pass (every run of the sweep recreates them).

## Tests added in round 1

- `crm-api/src/offer-drafts/answersSchema.date.qe.test.ts`: control + 3 `it.failing` (F4).
- `specs/20261126-teams/qe-followups-nul-sweep.ts` extended: arrays carry a second element, up to 80 body leaves per operation (was 12), an all-leaves-NUL request and a NUL-in-an-unknown-key request per body, `SWEEP_SYSTEM=1` for `/system/*` with the user token, and a 5xx control prints its status, body and sent payload (that is how F4 was isolated).
- The round-0 `refund-api/src/requests/nul.routes.qe.test.ts` was turned into plain tests by the fix commit; I confirmed they pass and go red when the fix is removed.

## Security

The owasp-reviewer pass on the F1 fix is still recommended (three more services now refuse at the schema and re-throw a NUL database error through `runExit` / `dbFailure`); `security-review-followups.md` (commit `c56516bc`) predates the fix round.

## Self-critique

My `/system/*` coverage behind a real service credential is by reading code, not by a request, the crm live sweep ran on a database that is behind its migrations (its schema layer was exercised, its database safety net was not), and the hot-reload explanation in E8 is a hypothesis I could not test without a restart.

---

# Round 0 (superseded by Round 1 above; kept as written)


Measured at `d56d5d18` (tree clean before; my only additions are the two files listed under "Tests added"). Full mode (rigor production).
Backend tests ran on `*_test` databases only, clean env (`env -i`), foreground. Mutations were applied and reverted with `git checkout`
(final `git status` shows only the new test file). Live probes ran on the dev stack with sessions minted by the e2e helpers.

## QE verdict: FAIL        (measured at d56d5d18)

D2 is **not closed**: the safety net is bypassed on three of the eleven services (refund-api, estimai-api, notify-api), where a NUL in an id
or cursor still answers 500 on the real routes. Their unit tests pass because they throw a hand-built error at a probe route. R12, R13,
the auth body limit, the accounting seed message and the meetings visibility check all pass. Nothing is BLOCKED; one e2e global-setup step
(refund release) cannot run on this machine (environment, E6).

| Check | Threshold | Actual | Result |
|---|---|---|---|
| D2 live sweep, every documented operation x one NUL at a time (auth, projects, crm, meetings, activities, accounting, inventory, hours) | 0 5xx, no echo | 0 5xx; no echo outside `instance` except 404 `detail` quoting the path (info) | ✓ |
| D2 live sweep, refund-api / estimai-api / notify-api | 0 5xx | 3 + 7 + 2 = 12 requests answer 500 (control 200/404) | ✗ F1 |
| D2 named routes: projects `GET /projects?q=%00`, auth `POST /admin/departments`, `GET /admin/users?q=%00` | 400 | 400, 400, 400; body names the character only | ✓ |
| D2 edges on the auth guard (escape `\u0000`, `\\\u0000`, raw NUL byte, key, `%00` path, `%2500` literal, other content types) | NUL 400, text passes | as designed (`\\u0000` is text and passes; `%2500` passes) | ✓ |
| D2 projects-api text forwarded to another service (`GET /companies?q`, `GET /queue?q`) | 400 | 503 `crm_unavailable` | ✗ F2 |
| auth body limit | 413 over 256 KiB, before any read | declared 300 KiB: 413 unauthenticated; chunked 300 KiB: 413; over-limit body holding a NUL escape: 413 (not 400); exactly 256 KiB passes (401), +1 byte 413; text/plain over: 413; legal-entity route still 413 `request_too_large` | ✓ |
| auth sign-in unaffected | works | `POST /auth/sign-in/social` 200 with the provider URL; `/test-auth/session` + `/auth/token` (used by every probe) work | ✓ |
| Meetings visibility after `jwtOnly` | non-participant sees nothing | creator list 1, `?ids=` 1; other user list 0, `?ids=` 0, `?role=participant` 0, `GET /meetings/{id}` 404; admin list 0, 404; no token 401, bad token 401 (meeting deleted after) | ✓ |
| Mutation: list guard `jwtOnly` -> `selfScoped` | red | meetings-api 1 fail | ✓ |
| auth `bun test` (operai_auth_test) + typecheck | 0 fail | 1728 pass, 0 fail; tsc 0 | ✓ |
| projects-api `bun test` (projects_test) + typecheck | 0 fail | 1537 pass, 0 fail; tsc 0 | ✓ |
| crm-api `bun test` (crm_test) + typecheck | 0 fail | 2430 pass, 1 fail in the main tree, 0 fail in a clean worktree of HEAD (E1); tsc 0 | ✓ (E1) |
| activities-api `bun test` (activities_test) + typecheck | 0 fail | 846 pass, 1 fail (hook timeout) in runs that overlapped another suite; 15/15 alone, in a clean HEAD worktree and again at the end (E3); tsc 0 | ✓ (E3) |
| meetings-api `bun test` (meetings_test) + typecheck | 0 fail | 2023 pass, **1 fail, twice, also in a clean HEAD worktree**: `src/lib/nul.test.ts` "Prisma-wrapped, model query: one warning" (F3); tsc 0 | ✗ F3 |
| hours-api `bun test` (hours_test) + typecheck | 0 fail | 1903 pass, 1 fail = `src/lib/env.test.ts` (the direnv file of hours-api names the `meetings` database), expected until the user fixes it (E4); tsc 0 | ✓ (expected red) |
| accounting, inventory, refund, estimai, notify: full suites + typecheck | 0 fail | accounting 674/0, inventory 914/0, refund 2383/0 (before my test), estimai 362 pass + 2 fail (E5), notify 673/0 in a clean HEAD worktree with placeholder env and 659/6 in the main tree (E2); tsc 0 for all | ✓ (E2, E5) |
| NUL files of those services | pass | accounting 12, inventory 12, refund 9, estimai 9, notify 9 pass (none goes through a route: the reason F1 was missed) | ✓ |
| `scripts/check-single-replica.ts` + test | exit 0, 20 pass | exit 0 ("5 services, each exactly 1 replica"); 20 pass | ✓ |
| R12 mutations of `.railway/railway.ts` (projects-api: 2 replicas, two regions of 1, `replicas: REPLICAS`, 0) | exit 1 naming service and reason | all four exit 1 with the decision file's message; file restored | ✓ |
| R12 mutations of the checker (`total === 1` -> `>= 1`, repeated-service limit, repeated-`replicas` limit, comment stripping removed) | test red | 3, 1, 1, 1 failures | ✓ |
| `scripts/check-shared-copies.ts` + test | 37 groups in sync, 31 pass | in sync, 31 pass; one changed line inside `nulDatabaseError` (hours, meetings, estimai), `authzFlight` (crm) or `deadlineReader` (projects) exits 1 naming the file | ✓ |
| R13: 20 constant/guard mutations (both HOST_AUTHZ_WAIT_MS, HOST_PATH_REST_MS, both RESOLVE_TIMEOUT_MS, TEAMS_HOST_WAIT_MS, RELAYED/OWNER_TIMEOUT_MS, NAMES_WAIT_MS, LIST_HOST_ROUNDS, both consumers' RESOLVE_TIMEOUT_MS, both identities REQUEST_TIMEOUT_MS, LIST_NAMES_WAIT_MS, RESOLVE_BATCH, both IDS batch sizes, host routes back on `authzMiddleware`) | each red | 20 of 20 red; `createAuthzMiddleware(null)` for the host variant survives the cross-package files but is red in `authz.middleware.test.ts` of both services (2 fail each) | ✓ |
| `tools/env-doctor` `bun test`; `mise run env:doctor` | 0 fail | 300 pass; "all checks passed" | ✓ |
| accounting seed on an unmigrated database | names the missing schema, writes nothing | `seed:welld-ch --dry-run` on an empty database: "has no schema ... apply the migrations first (`cd accounting-api && bun run db:deploy`); nothing was added", exit 1 | ✓ |
| e2e `admin-teams`, `projects-teams`, `teams-qe-exploratory`, `projects-teams-qe-exploratory` | all pass | 23/23 pass (1.4 min) with `E2E_SKIP_REFUND_ACCOUNTING_RELEASE=1` and POSTGRES_USER / POSTGRES_PASSWORD exported | ✓ |
| e2e global setup with no `E2E_SKIP_*` | completes | stops at the refund accounting release, step `propose` (E6) | environment, not a defect |

## Defects

Class A, a mechanism that the failing path never reaches (one class, three placements):

**F1. D2 safety net bypassed on refund-api, estimai-api, notify-api** (owner: backend-dev, one task per service; severity medium: 5xx on caller input, no data exposure).
Live, 12 requests, each with a control that is not a 5xx:

| Service | Request | Live answer |
|---|---|---|
| refund-api | `GET /requests/a%00b`, `GET /requests/a%00b/export`, `GET /requests/{id}/lines/{lineId}/attachments/{aid}/url` with the NUL in the id | 500 "Unexpected database failure fetching refund request" |
| estimai-api | `GET`/`DELETE /estimates/a%00b`, `GET`/`POST /estimates/a%00b/collaborators`, `PATCH`/`DELETE .../collaborators/{id}`, `DELETE .../collaborators/me` (7) | 500 "Unexpected database failure fetching estimate" |
| notify-api | `GET /notifications?cursor=a%00b`, `DELETE /push/devices/a%00b` | 500 "Unexpected database failure listing notifications / deleting a push device" |

Root cause: `isNulDatabaseError` runs only in `app.onError`, and on these three services the error never gets there. refund-api's repo functions wrap
every Prisma failure in a tagged `DatabaseError` (`toDbErr`) that the route renders as a 500 problem (on some lifecycle and settings routes, a 404 that
quotes the id); estimai-api's routes `throw new Error("Unexpected database failure ...")` without the cause; notify-api renders its `DatabaseError` as a
500. The `nul.test.ts` and `nul.probe.ts` of the three services throw a hand-built Prisma-shaped error at a probe route that carries the real
`onError`, so they prove the handler and never the path a real request takes. That test is enough on the other eight services because there the
Prisma error does propagate (sweep: 0 5xx).
Failing test: `refund-api/src/requests/nul.routes.qe.test.ts` (2 `it.failing`: `GET /requests/{id}` and `POST /requests/{id}/submit`; remove `.failing` when fixed).
estimai and notify: repro is the committed sweep, `cd shell && bun ../specs/20261126-teams/qe-followups-nul-sweep.ts estimai` (also `notify`, `refund`).
Fix shape for the dev agent: refuse NUL at the schema of every id, cursor and text a route takes (as projects-api did), and/or map a `DatabaseError`
whose `cause` is a NUL refusal to the 400 where the wrapper is built; then add the route-level test the unit tests lack.

Class B, a placement missed by the schema fix (projects-api):

**F2. `GET /companies?q=<NUL>` and `GET /queue?q=<NUL>` answer 503 `crm_unavailable`** (owner: backend-dev projects-api; severity low). `companies.routes.ts`
(`q: z.string().max(200).optional()`) and `queue.routes.ts` (`QueueQuery.q`) were not moved to `searchText`, so the NUL is forwarded to crm-api, which
refuses it, and projects-api reports "the CRM is unavailable". Not a 500, no echo, but a wrong status that reads as an outage. Placements: companies `q`
✗ (503, control 200); queue `q` ✗ by the same code (503 here, but its control is also 503 because crm-api's `/system/deals` read is unavailable in this
environment, so only the code is conclusive); `GET /projects?q` ✓; `/attachable-teams?q` ✓. Fix: `searchText(200)` on both queries.

Class C, a test that depends on what ran before it:

**F3. `meetings-api/src/lib/nul.test.ts` fails in the full run** (owner: backend-dev meetings-api; test defect, no production effect). The A09 block spies on the
global `console.warn` and asserts `toHaveBeenCalledTimes(1)`; in the full suite the first case sees 6 calls, because an earlier file
(`src/auth/guards.test.ts`; bisected: `guards.test.ts` + `nul.test.ts` alone reproduces, `nul.test.ts` alone passes) leaves a pending authz timeout that logs a
warning during the spy's lifetime. Deterministic, 2 of 2 in the main tree and in a clean worktree of HEAD (so not the environment). The other services'
NUL tests were green in their full runs. Fix: assert on the calls that carry `[nul]` (filter `mock.calls`), not on the total. Not committed as a red test:
it already exists and is red in the full run.

## Info (no verdict effect)

- 404 bodies quote the request path or id in `detail` for a NUL: crm-api (`POST /offer-templates/{id}/try-preview`, `POST /deals/{id}/offer-draft/preview`),
  refund-api (`Refund request a\u0000b not found`, `Unknown refund setting "a\u0000b"`, `a\u0000b is not an expense type`, 10 routes). The caller's own text, JSON-escaped, not a 5xx; but
  "no value echoed except `instance`" does not hold there. The refund request routes change with F1.
- crm-api `PUT /deals/{id}/offer-draft` answers 500 for the sweep's generated body even without a NUL (control also 500): not NUL, not part of this follow-up, not investigated
  (my generated body is probably outside what the route accepts, but a 500 there is worth a look).
- `accounting-api/scripts/seed-welld-ch.ts`: `export const USAGE ="Usage:` (missing space, from 81d77dbb), cosmetic. The unmigrated run also prints Prisma's own error text
  (table name, script path) before the new sentence; no connection string was in it.
- hours-api: every operation of its sweep answered 400, none 5xx. The sweep skips `/system/*` (service credentials, not minted here), so the safety net of those routes is covered by unit tests only.

## Environment faults (not defects, no fix round)

- E1. crm-api `offerDrafts.preview.test.ts` ("refuses to start with the switch on and no URL or no service client"): 1 fail in the main tree, 32/32 in a clean worktree of HEAD and at the base `3949d587`. The child boot picks up the gitignored local dotenv file of the working directory. The follow-ups did not touch the test or the env module.
- E2. notify-api: 6 fails in the main tree (child-boot tests: `env.retiredToken.test.ts` x4, `systemAuth.logPrivacy.test.ts`, one unnamed); 673 pass / 0 fail in a clean worktree of HEAD with placeholder env (`ALLOWED_ORIGINS, AUTH_JWKS_URL, AUTH_ISSUER, AUTH_AUDIENCE, SERVICE_AUDIENCE, PUSH_ENABLED=false`). Same cause as E1.
- E3. activities-api `scripts/import-crm-activities.test.ts`: a 5 s hook timeout in two runs that overlapped another suite on the same Postgres; 15/15 on every quiet run. Load-sensitive, not seen at the base.
- E4. hours-api `src/lib/env.test.ts`: red as expected, the direnv file of hours-api still ends in `.../meetings`. Not edited.
- E5. estimai-api: 2 unnamed fails, Prisma P1000 from the auth client (a test reading auth's database needs credentials this clean env does not carry).
- E6. e2e global setup with no skip flag, in order: accounting seed ran ("accounting seeded (done)"); **refund release, step `propose`, fails**: (a) with nothing exported, `ACCOUNTING_INTERNAL_URL: expected string, received undefined` (refund-api's direnv file does not set it, `mise run dev` defaults it, and the setup runs `direnv exec` alone); (b) with `ACCOUNTING_INTERNAL_URL=http://localhost:8089` exported, Prisma P2022 (a column missing): refund's dev database is not migrated yet (`cd refund-api && bun run db:deploy`, the user's step). The legal-entities step then fails with PostgresError 28P01 unless `POSTGRES_USER` and `POSTGRES_PASSWORD` are exported (the mise task defaults to postgres:postgres); with both exported: "legal-entity registry in order: welld_it v2, welld_ch v2". With `POSTGRES_USER`, `POSTGRES_PASSWORD` and `E2E_SKIP_REFUND_ACCOUNTING_RELEASE=1` the whole teams e2e is green. Suggestion (not a defect of the follow-ups): have `global-setup.ts` pass `ACCOUNTING_INTERNAL_URL` to the refund script as the docs say `mise run dev` does.
- Left on the shared Postgres: the empty database `qe_unmigrated_test` (made for the seed check; my attempt to delete it was refused by the destructive-SQL guard, so the user may remove it) and the users `qe-followup-probe`, `qe-vis-creator`, `qe-vis-other` (@operai.test). Meetings and estimates created by the probes were deleted; the e2e teams removed their own.

## Tests added

- `refund-api/src/requests/nul.routes.qe.test.ts`: 2 `it.failing` cases (route-level NUL id, F1), both seen to fail on the live behaviour (bun reports them as expected failures and turns them red when F1 is fixed).
- `specs/20261126-teams/qe-followups-nul-sweep.ts`: the repeatable live sweep (not a unit test; needs the dev stack).

## Security

An `owasp-reviewer` pass is recommended on the F1 fix (a refusal in front of three more services) and, if not yet done, on the R13 middleware change: two authorization
middlewares gained a single flight, a bounded wait and a 503 on timeout, and one meetings route stopped resolving permissions. Both were probed here (mutations red, a non-participant sees
nothing), but `specs/20261126-teams/security-review.md` predates these commits and the decision file asks for the review.

## Self-critique

My live sweep covers only documented routes, at most 12 body strings per route and no `/system/*`, so a 5xx behind a service credential or in a 13th field would not show; and the F3 bisect stops at the file (`guards.test.ts`), not at the exact timer.
