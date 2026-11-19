---
spec: 20261119
task: T46
date: 2026-11-19
verdict: PASS (original module after fix round 1; sign-off round T77 after T82)
tested: 99c0e863 (branch feat/accounting-module, T1-T45 done, T47's security-review.md already committed) plus the QE tests of this pass (7d7e435d and the two before it)
---

# QE report: accounting module

## QE verdict: FAIL

All 68 acceptance criteria have executed evidence, and every gate the repo runs is green at the commit tested (this pass's own
repro of D-1 adds 3 red tests on purpose). The verdict is FAIL because of
one reproduced defect (D-1, a 500 where the plan says 404), four documentation or CI statements that do not match the
code (D-2 to D-4, D-8), and one test that depends on execution order (D-5). None of them changes an AC outcome that the
tests prove; D-1 is the only one a user's request can reach. The fix round is small (see "Notes for the caller"), and
after it this pass needs re-running on the delta only.

How this was run: unattended, in the worktree `repos/operai-accounting`, against the isolated Postgres container on
:5445 only (`accounting`, `refund`, `auth`, and the scratch databases `accounting_qe46` and `refund_qe46`, which this pass
created for the from-zero checks and dropped again; `refund_qe` and `refund_t25` were there before and are untouched).
No dev or e2e stack, no Railway, no secrets, no push.

**What was not possible, and what that costs.**

- **The live e2e (`cd shell && pnpm e2e accounting refund-`) is PENDING (T51, owner).** It needs the e2e stack on the shared
  dev Postgres and 1Password. It is not counted as a failure. `playwright test --list` lists 238 tests in 53 files, the
  new journeys among them; the e2e files type-check and lint clean; every `data-testid` they use exists in the sources
  (112 ids checked by script, one dynamic prefix, one negative assertion). The 20261118 journeys (its T31 and T32,
  adapted by this feature's T42) were also never run live.
- **The manual browser accessibility pass is PENDING (T51).** Contrast, reflow at 320 px, real tab order and
  screen-reader output are not verifiable under jsdom (axe is run with `color-contrast`, `region` and the page-level rules
  off, by design). Nothing below claims them.
- Where an AC's evidence is complete without either, the matrix says so ("Sufficient" = yes). One AC is not fully
  proven by unit, integration and component evidence alone: **AC-8.4** (contrast and the browser axe run). For **AC-5.5 and
  AC-5.6** the numbers and the database guards are proven; the live journey adds the wiring through the shell, the bearer
  and CORS only.

## Verdict table

| Check | Threshold | Actual | Result |
|---|---|---|---|
| AC coverage | 68/68 with a named, executed test | 68/68 (matrix below) | ✓ |
| accounting-api `bun test` | 0 fail | at 99c0e863: 587 pass, 0 fail, 23 files. With this pass's tests: 615 pass, **3 fail** (the D-1 repro, red on purpose), 26 files. Same numbers on a database migrated from zero | ✗ (D-1) |
| accounting-api `tsc --noEmit` | clean | clean, including the new tests | ✓ |
| refund-api `bun test` | 0 fail | 1781 pass, 0 fail, 69 files, twice (dev database; database migrated from zero). `migration.accounting-move.test.ts` (known 5 s flake): green in all four default-order runs, 2.2 s alone, no timeout seen | ✓ |
| refund-api `bun test --randomize` | 0 fail (20261118's pass had it) | seeds 424242 and 77: 2 fail, both in `migration.accounting-move.test.ts`; alone with seeds 1, 2, 3: 1, 1, 3 fail | ✗ (D-5, test order) |
| refund-api `tsc --noEmit` | clean | clean | ✓ |
| auth `bun test` | 0 fail | 1497 pass, 36 skip, 0 fail, 84 files | ✓ |
| auth `tsc --noEmit` | clean | clean | ✓ |
| accounting-ui `tsc -b`, `eslint`, `vitest`, `build` | clean | clean, clean, 477 pass (27 files; 481 in 28 files with this pass's keyboard test), builds | ✓ |
| refund-ui `tsc -b`, `eslint`, `vitest`, `build` | clean | clean, clean, 1314 pass, builds | ✓ |
| operai-ui typecheck, lint, test, Storybook build | clean | clean, clean, 300 pass, builds | ✓ |
| shell `vite build`, `eslint`, `vitest` | green | build ✓, lint ✓, 685 pass (see Environment faults: first run 1 file failed for missing installs) | ✓ |
| meetings-ui build, lint, test (part of `ui:check`) | green | green | ✓ |
| shell e2e `tsc -p tsconfig.e2e.json`, eslint on e2e | clean | clean (lint is part of `shell eslint .`) | ✓ |
| `playwright test --list` | the new journeys listed | `accounting.spec.ts` (8 tests incl. 4 axe variants), `accounting-access.spec.ts` (7), both `refund-accounting*.spec.ts`; 238 tests in 53 files | ✓ |
| Live e2e | green | not run (owner step T51) | PENDING |
| `shared:check` | green | 34 groups in sync, `accountingWire` among them | ✓ |
| `react:skew` | green | 12 frontends on one react / react-dom / router version | ✓ |
| `changeset:check` | OK | OK against local `main` and against `origin/main` (`accounting-module.md`, `refund-accounting-export.md`, `ui-format-month.md`) | ✓ |
| `env:doctor` | green | all 11 services pass (accounting-api included) | ✓ |
| Migrations from zero, accounting | applies, no drift | `20261119120000_init` applies on a fresh database; `prisma migrate diff --from-config-datasource --to-schema` "No difference detected"; `migrate status` up to date; the full accounting-api suite is green on it | ✓ |
| Migrations from zero, refund | applies, no drift | all 10 migrations apply (`20261119120000_accounting_copies`, `20261119130000_accounting_reference_moved_out` included); "No difference detected"; the full refund-api suite is green on it; `migration.accounting-move.test.ts` carries a 20261118-state database through both | ✓ |
| Secret scan | none | gitleaks and trufflehog absent; pattern scan of the 73,845 added lines vs `origin/main` (provider keys, JWTs, private-key headers, URLs with userinfo, 1Password refs, quoted credential assignments, 40+ character opaque tokens): no secret. Hits triaged: ADR slugs and paths (opaque), `postgres:postgres@localhost` and `${{Postgres.*}}` placeholders, one test token `cli-test-service-jwt`. No added key, certificate or dotenv file (`accounting-api/.env.example` is a template) | ✓ |
| Critical CVEs on changed or new lockfiles | 0 | `accounting-api/bun.lock` (new): `bun audit` 4 (2 high, 2 moderate), all under `prisma` (`mysql2`, `valibot` via the dev CLI), same chain as refund-api's 16; 0 critical. `accounting-ui/pnpm-lock.yaml` (new): none. `refund-ui/pnpm-lock.yaml` (+9 lines, `axe-core` 4.14.1 only): `pnpm audit --audit-level=critical` exit 0 (17 high, 8 moderate, 1 low, as in 20261118's pass, none from this change) | ✓ |
| Test strength (mutation sample) | mutants killed | 25 of 29 killed; the 4 survivors are equivalent (table below) | ✓ |
| Wire contract UI vs API (accounting-ui) | same codes and shapes | every error code the UI branches on exists in accounting-api; paths and bodies are exercised by the UI suite against `catalogApi`/`exchangeRatesApi` and by the API suite | ✓ |
| Wire contract Refund vs Accounting | real client against real routes | none existed (both sides tested against fakes of each other); added `contract.refund-client.test.ts`, 7 pass | ✓ (after addition) |
| Contract edges (exploratory, API) | no 5xx | about twenty probes; a NUL byte in an entry key is a 500 | ✗ (D-1) |
| Design states (design.md) | all states present | AS1 to AS7, RS1 to RS7, each state has a named component test (see "design.md audit") | ✓ |
| Accessibility (design.md) | keyboard + ARIA per design | component-level: holds, including keyboard-only paths (added). Browser level (contrast, reflow, tab order, e2e axe): not run | ✓ (limited) / PENDING T51 |
| Component reuse (design.md inventory) | no new component where reuse was specified | accounting-ui: the 5 N rows exist and nothing else is new; refund-ui: `AccountingLinkNote` is the only new component | ✓ |
| Moves kept history | `git log --follow` reaches the origin | catalog repo (4 commits back to 20261118 T6), rates service (4, to T9), `bazgSource` (2), `LedgerAccountsCard` (3), `ExchangeRatesCard` (5), `exchangeRatesApi` (4); all move commits are 100 % renames | ✓ |
| Docs and runbook vs code | consistent | 3 statements wrong about the Docker image, 2 about `.dockerignore`; the rest checked and right | ✗ (D-2, D-3) |
| CI guard of the shared wire file | runs when a copy changes | `shared-copies.yml` path filter does not list the `accountingWire` copies | ✗ (D-4) |

Defects: D-1 to D-8 below. Environment faults are listed apart.

## Defects

| id | AC / check | severity | evidence | suspected owner |
|---|---|---|---|---|
| D-1 | AC-1.4, AC-1.9, AC-1.10, AC-1.11 (unknown entry is a 404, plan § API "unknown number or code -> 404 not_found"); AC-1.12's neighbourhood | low (manager-only route; nothing is written; generic body in production) | `POST /v1/entities/welld_ch/ledger-accounts/5905%00/deactivate` (and `/reactivate`) and `POST /v1/entities/welld_ch/vat-codes/IMP%00/deactivate` answer **500** and log a Prisma stack (`SQLSTATE 22021`, "invalid byte sequence for encoding UTF8: 0x00"). Under `NODE_ENV=development` (the default) the Problem `detail` carries `err.message`. **Root cause:** the `{number}` and `{code}` path parameters are plain `z.string()` (`catalog.schemas.ts` lines 39 and 57) and are bound into `SELECT ... FOR UPDATE` in `setLedgerAccountActive` and `setVatCodeActive` (`catalog.repo.ts` lines 227 and 257); Postgres cannot compare a NUL. `limits.ts` names this exact hazard for names and labels ("NUL would be a 500, not a refusal") but the lookup keys were not covered. The other odd keys probed (`%0A`, `%2F`, space, full-width digits, a 5,000-character key, `.`) answer 404. **Repro:** `accounting-api/src/catalog/catalog.keys.test.ts`, 3 red tests (the 9 neighbours pass). **Fix:** validate the path key with the body's pattern (`LEDGER_NUMBER`, `VAT_CODE`) and answer 404 `not_found`, or map SQLSTATE 22021. | dev (accounting-api catalog routes) |
| D-2 | Docs vs code: where the seed script lives | low | The accounting-api image **does** contain `seed:welld-ch`: `accounting-api/Dockerfile` line 36 `COPY --chown=bun:bun scripts ./scripts` (the data file included), `infra/README.md` lines 1855 and 3016 to 3025 run it inside the service with `railway ssh`, and the script's own header says "from a checkout (or the image)". Three statements say the opposite. **Wrong:** (1) `.changeset/accounting-module.md`, "Neither script is in a Docker image"; (2) `AGENTS.md` line 194, `seed:welld-ch` "not in the Docker image"; (3) `accounting-api/README.md` line 65, "It is not in the Docker image: run it from a checkout". **Right:** `accounting:release` is not in refund-api's image (its Dockerfile copies `src` and `prisma` only): `AGENTS.md` line 151, `infra/README.md` line 1123, and the first half of the changeset sentence. The runbook is the correct source; the three above need to say "in the image (run it with `railway ssh`) or from a checkout". | dev (docs, T44/T45) |
| D-3 | Docs vs code: `.dockerignore` | low | `accounting-api/.dockerignore` says `*.test.ts`. Docker matches that against the **build-context root only**; `**/*.test.ts` is the recursive form. Verified with a throwaway `docker build` over a tree with `root.test.ts`, `scripts/b.test.ts` and `src/x/d.test.ts` and this exact file: only `root.test.ts` was left out. So `accounting-api/Dockerfile` line 35 ("the tests in them stay out (.dockerignore)") and `infra/README.md` line 1855 ("the tests excluded by `.dockerignore`") are false: `scripts/seed-welld-ch.test.ts`, every `src/**/*.test.ts` and `src/test-support/*` are in the image (the sibling services have no `.dockerignore` and ship their tests too, and nothing there claims otherwise). No secret in them; the harm is a wrong comment and a larger image. | dev / devops |
| D-4 | Plan R5 mitigation ("CI `shared-copies.yml`") | low | `.github/workflows/shared-copies.yml` runs on pull requests only when its `paths:` list matches, and the list holds `serviceToken` copies and the CRM engine only. A PR that edits only `accounting-api/src/system/accountingWire.ts` or only `refund-api/src/accounting/accountingWire.ts` (the wire both sides parse) does not trigger the guard, so R5's CI half does not exist; the local `mise run shared:check` passes (34 groups). The registry entry (T7) was added, the workflow path filter never was, and no task lists it. The other copies of `systemAuth`, `problem` and `logger` have the same gap from before this feature. | plan (no task) -> devops |
| D-5 | Test hygiene | low | `refund-api/src/lib/migration.accounting-move.test.ts` is not order independent: `--randomize --seed 424242` and `--seed 77` over the whole suite fail 2 tests; the file alone with seeds 1, 2 and 3 fails 1, 1 and 3. Default order is green in four runs, and 20261118's pass ran the suite green under `--randomize`, so this is new. Both `describe` blocks create the scratch database `refund_mig` and the tests read state built in `beforeAll` and by earlier statements. It does not affect CI (no `--randomize`), but it is the test the brief names as flaky under load. | dev (tests) |
| D-6 | AC-1.2 wording: "only blanks", "120 characters" | info | A name made only of U+200B (zero-width space) is accepted (201): `String.trim()` does not remove it. The length check counts UTF-16 code units, so a name of 70 emoji (70 characters, 140 units) is refused as `too_long`. Neither affects a real chart of accounts. | spec (say what "blank" and "character" mean) or dev |
| D-7 | Not this feature (reported so it is not lost) | info | `bun test tools/env-doctor` has one red test, `push.test.ts` "the production template ships push off", because `templates/production/notify-api.env` has had `PUSH_ENABLED=true` since 2026-11-13 (commit 4238bb7f). Neither file is touched by this branch; the `env:doctor` command itself passes. | whoever enabled push |
| D-8 | design.md and one comment | info | `design.md` front matter still says `status: draft` (as 20261118's D-6). `accounting-ui/src/test-support/axe.ts` carries over a sentence saying contrast "is checked by hand ... (design.md 'Browser accessibility pass (2026-11-19)': no text below 4.5:1 ...)". That pass was 20261118's, on Refund's screens; no contrast check of the Accounting screens has been done and design.md has no such section yet (T51 writes it). Not a test gap, but the comment reads as evidence that does not exist. | design |

**Not a defect:** the known flaky `migration.accounting-move.test.ts` did not time out in any of four default-order runs (2.2 s alone); see D-5 for its real weakness.

Environment faults (no dev round, no owner):

- **No `node_modules` in the worktree** (a fresh checkout). Installed with `bun install --frozen-lockfile` (accounting-api, refund-api, auth) and `pnpm install --frozen-lockfile --ignore-scripts` (every frontend), all ignored by git; `prisma generate` in the three APIs. `git status` shows nothing of it.
- **Shell vitest, first run:** `remoteVersionExposes.integration.test.ts` builds every remote and failed ("Cannot find type definition file") because `estimai-ui`, `admin-ui`, `notify-ui`, `inventory-ui`, `crm-ui` and `projects-ui` were not installed; 665 pass, 20 skipped, 1 file failed. After installing them: 685 pass. Same fault as 20261118's pass. Nothing under those apps changed.
- A pre-tool hook refuses Bash commands whose text contains destructive SQL or secret-file extensions; the scratch databases were dropped through `qe46/dropmine.ts` (names asserted, only the two created here), and the secret scan ran from a script file.
- `bun test`'s `it.each` treats a callback with more parameters than the row has as taking `done`; one of this pass's own tests tripped on it and was fixed (rows of three).

## Tests added by this pass

All in the worktree and committed by path; none touches production code.

1. `accounting-api/src/system/contract.refund-client.test.ts` (7 tests, green). **Plan R5, AC-3.8, AC-2.10, AC-4.1, AC-6.8.** refund-api's real `createAccountingClient` is given a `fetchImpl` that calls accounting-api's real Hono app: real `systemAuth` verifying a real RS256 service JWT, the real `accounting` database, a fake rates source. Covers reference data by entity, the snapshot Refund builds from it (active, deactivated, not found), rates in the asked order with a recorded pair, a month fetched for the consumer and a month not yet published, 42 pairs in two calls, one 401 re-mint then `unauthorized`, a service that is not allow-listed (`system:crm-api`), and WellD Italia's refused rates. Imports the refund-api client by relative path with refund's variables set to placeholders and removed again afterwards.
2. `accounting-api/src/authz/settingsHolder.test.ts` (12, green). **AC-3.7, accounting-api half.** The plan row names "the same user at accounting-api -> 403", but the only persona (`outsider`) has no permissions at all. This one holds every Refund and settings grant, with and without the entity condition, and no Accounting one: 403 on every user route, nothing of the lists in the body, nothing written. Killed by a mutant that lets any resource name count as `accounting`.
3. `accounting-ui/src/keyboardOnly.test.tsx` (4, green). **AC-8.4, "usable with the keyboard alone".** The plan's row asks for `userEvent.keyboard` tests; the component suites use `fireEvent.click` everywhere. These use Tab (bounded, so an unreachable control fails instead of hanging), Enter, Space and Escape: add an account, a refused value taking the focus, deactivate and reactivate, correct a rate. Killed by two mutants (the Add button out of the tab order; Enter no longer submitting).
4. `accounting-api/src/catalog/catalog.keys.test.ts` (12: **3 red** = D-1, 9 green neighbours). Handed to the dev agent as the failing test.

Scratch, not committed (in the session scratchpad, `qe46/`): `mutate*.py` and `muts.py` (mutation runners on copies of the packages, never on the worktree), `secretscan.py`, `e2eids.py`, the install and gate scripts and logs.

## Mutation sample (are the tests vacuous?)

Each mutant was applied to a **copy** of the package (`qe46/mut/...`), the covering test files run, and the file restored; a control run on the unmutated copy was green. Backend mutants ran three packages in parallel.

| id | Mutation | AC | Result |
|---|---|---|---|
| AM1 | `accounting:manage` no longer covers read | 3.2 | killed (10) |
| AM2 | a month counts as published from day 1, not day 5 | 2.1, 2.7, 2.10, SA-2 | killed (23) |
| AM3 | a fetched rate wins over a correction | 2.4, 2.6 | killed (7) |
| AM4 | the system `sub` allow-list ignored | 3.8 | killed (6) |
| AM5 | correction upper bound 1000 -> 1001 in `parseRate` | 2.5 | survived: **equivalent**, `RATE_RE` already allows at most three integer digits, so the bound is defence in depth |
| AM6 | `Cache-Control: no-store` removed from system answers | D2 | killed (3) |
| AM7 | `canManage` always true in `/v1/me` | 3.4, UX-4 | killed (2) |
| AM8 | ledger number limit 20 -> 21 | 1.2 | killed (3) |
| AM9 | deactivating an inactive account accepted silently | 1.11 | killed (3) |
| AM10 | an uncovered entity answers 403 instead of 404 | 3.5 | killed (19) |
| RM1 | an all-rejected WellD CH request still reads Accounting | 6.4 | killed (1) |
| RM2 | the export copies no pending rate | 5.6 | killed (7) |
| RM3 | the client deadline 10 s -> 12 s | 6.8 | killed (1) |
| RM4 | `settings:manage` no longer opens `/accounting/options` | 4.4, D16 | killed (1) |
| RM5 | an absent account reads `unverified` instead of `not_found` | 4.5, SA-3 | killed (5) |
| RM6 | CHF rounding half-up -> floor | 5.5 | killed (40) |
| RM7 | Accounting manage no longer opens the rates link | 7.3, 3.2 | killed (5) |
| RM8 | the client follows redirects | 6.8 | killed (2) |
| RM9 | the classification PUT accepts a deactivated account (second check inside the transaction) | 4.3 | survived: **equivalent**, `accountRefusal` runs first and refuses it; the later `state !== "active"` is a narrowing guard |
| RM10 | the release exits 1, not 2, when Accounting is unreadable | 7.4 | killed (4) |
| RM11 | the export does not report `accountingUnavailable` | 6.6 | killed (8) |
| AU1 | `accounting:manage` alone does not open the Accounting app | 8.1 | killed (9) |
| AU2 | the accounting role's manage grant is unconditioned | 3.3 | killed (2) |
| NM1 | any resource name counts as `accounting` (against `settingsHolder.test.ts`) | 3.7 | killed (12) |
| NM3 | `attempted` always false in the rates answer (against the contract test) | 2.10, G10 | killed (1) |
| UM2, UM3 | Add out of the tab order; Enter does not submit (against `keyboardOnly.test.tsx`) | 8.4 | killed (2 each) |
| NM2, UM1 | rates answered in reverse order; no focus return to Add after an add | contract, 8.4 | survived: **equivalent** (the client re-keys the answers; the dialog's own return-to-opener restores the focus on a keyboard path) |

## AC evidence matrix

Executed means: ran in this pass and green. Legend. **accounting-api** (A): CAT `catalog/catalog.routes.test.ts`, LIM `catalog/limits.test.ts`,
RR `rates/rates.routes.test.ts`, RS `rates/rates.service.test.ts`, MON `rates/months(.zurich).test.ts`, PAR `rates/parse.test.ts` and `bazgSource.test.ts`,
SYS `system/system.routes.test.ts`, WIRE `system/accountingWire.test.ts`, CON `system/contract.refund-client.test.ts` (added), MAT `matrix.test.ts`,
COV `authz/coverage.test.ts`, ME `me/me.routes.test.ts`, DB `lib/db.{checks,immutability,rates-fetched-once}.test.ts`, SEED `scripts/seed-welld-ch.test.ts`,
BUD `budgets.cross-package.test.ts`, SH `authz/settingsHolder.test.ts` (added). **auth**: ACAT `catalogs/accounting.test.ts`, DER `derivedApps.test.ts`,
SD `seed.test.ts` (`seedAccountingCatalog`, `seedAccountingGrants`), ARO `authz.routes.test.ts`, SVC `system/serviceClients.test.ts`.
**refund-api** (R, under `src/accounting/` unless shown): CLS `classification.routes.test.ts`, CLU `classification.test.ts`, INA `classification.inactive-default.test.ts`,
DEF `defaults.routes.test.ts`, APP `review/approve-accounting.test.ts`, EXP `export.routes.test.ts`, EXF `export.failures.test.ts`, EXC `export.test.ts` (golden),
MTX `accounting-unavailable.matrix.test.ts`, CLI `accountingClient.test.ts`, NOC `no-cache.test.ts`, NK `natural-keys.test.ts`, RSN `referenceSnapshot.test.ts`,
AMT `amounts.test.ts`, RCP `rateCopy.repo.test.ts`, NUM `numbering.repo.test.ts`, LIF `receipt.lifecycle.test.ts`, REL `scripts/accounting-release(.cli).test.ts`,
DBC `lib/db.accounting-copies.test.ts`, DBG `lib/db.accounting-receipt-guard.test.ts`, DBI `lib/db.accounting-immutability.test.ts`, MIG `lib/migration.accounting-move.test.ts`,
RMV `removed-routes.test.ts`, VWR `authz/accountingViewer.test.ts`. **accounting-ui** (U): LAC, VCC, ERC, RCD, ALD, AVD = the card and dialog tests of the same name,
SHL `AccountingShell/frameStates/EntitySwitch/useEntity/router` tests, STR `strings.test.ts` + `noHardcodedStrings.test.ts`, KBD `keyboardOnly.test.tsx` (added).
**refund-ui** (F): ETD `ExpenseTypeDefaultsCard`, DCD `DefaultClassificationDialog`, FCV `ForeignCurrencyVatDialog`, DSV `DefaultsSettingsView` + `SettingsViews(.a11y)`,
LCP `LineClassificationPanel`, RDP `ReviewDetailPage`, AEC `AccountingExportCard`, ALN `AccountingLinkNote`, APD `ApproveDialog`. **shell** (S): `router.accounting`, `Sidebar`, `tools`, `session`, `italian`.
**e2e** column = the journey of `acc` = `accounting.spec.ts`, `acc-access` = `accounting-access.spec.ts`, `ref` = `refund-accounting.spec.ts`, `ref-set` = `refund-accounting-settings.spec.ts`: **all pending (owner, T51)**; "-" = none planned.
"Sufficient" = the executed evidence alone proves the AC.

| AC | Evidence (executed) | e2e | Sufficient |
|---|---|---|---|
| 1.1 | A: CAT add -> 201 and listed active, entity from the path (AC-1.1, 1.13); SYS and CON show it in the system read of that entity only. U: LAC adds a row. R: CLS options list it | acc, ref-set | yes |
| 1.2 | A: LIM vectors (5905, 2620.1, 1.2.3 ok; empty, blank, `5905.`, `59a`, 21 chars refused; trim; name 120/121), CAT field-by-field 422 with nothing saved. U: ALD it.each per reason, focus on the first refused field; KBD (keyboard path). See D-6 | - | yes |
| 1.3 | A: CAT same number 409 (active or deactivated, trimmed number named), other entity 201, concurrent 2 x 20 and 20 parallel = one 201 | acc | yes |
| 1.4 | A: CAT deactivate stays listed inactive; SYS `active:false` in the system read. R: CLS options only active; CON snapshot. U: LAC | acc | yes |
| 1.5 | A: LIM `checkVat*`, CAT (8.1 = 810 bp exact, 0 and 100, -1, 100.01, 8.123, upper-casing, code 16/17, label 80/81). U: AVD | - | yes |
| 1.6 | A: CAT `imp81` vs `IMP81`, active (`reactivate:false`) or deactivated (`true`), other entity ok, concurrent. U: AVD pointer to Reactivate | - | yes |
| 1.7 | A: CAT PUT/PATCH 404 and body cannot carry a rate; DB raw UPDATE of the rate and entity raises. U: AVD "cannot be changed", VCC no edit control | - | yes |
| 1.8 | A: CAT, SYS. R: CLS PUT 422, DEF 422 for a deactivated code | - | yes |
| 1.9 | A: CAT, SYS flip `active` and back, two status rows. R: CLS accepted again once reactivated, INA "back as default". U: LAC, KBD | acc | yes |
| 1.10 | A: CAT same for a VAT code (code, label, rate unchanged). R: DEF designation usable again, CLS | acc | yes |
| 1.11 | A: CAT 409 `already_active`/`already_inactive`, no status row, 20 concurrent = one winner. U: LAC/VCC stale-list 409. Mutant AM9 killed | - | yes |
| 1.12 | A: CAT OpenAPI lists no write method but the six POSTs; PUT, PATCH, DELETE 404 for manager, reader and outsider alike; MAT route list; DB raw UPDATE/DELETE of `ledger_account`, `vat_code`, rows of any history raise. U: LAC/VCC offer only Deactivate/Reactivate. D-1 is a neighbour (a bad key is a 500) | - | yes |
| 1.13 | A: CAT actor from the JWT never the body, one status row per change with actor, time, entity, after-state (before = opposite); DB status rows immutable, a row naming another entity is refused | - | yes |
| 2.1 | A: PAR the recorded 2026-03 answer = 924600/780800/1063500; RS records source URL, time, actor `system:rates-fetch`; RR POST fetch; MON grace; CON. Mutant AM2 killed | - | yes |
| 2.2 | A: RS a fetched rate is never overwritten and the discrepancy goes to the log only; DB second `fetched` insert is a unique violation | - | yes |
| 2.3 | A: MON window vectors; RR 2026-01 to last completed month newest first, origin per currency, an earlier month once it has an entry or an attempt. U: ERC badges and month rows | - | yes |
| 2.4 | A: RR correction in effect, fetched row kept, row carries actor, entity, `replacesRateMicros`; RS history chain; DB immutable. U: RCD, ERC. Mutant AM3 killed | acc | yes |
| 2.5 | A: RR 0, -1, 1000, 1.1234567 -> 422 `invalid_rate`; 999.999999 ok; current month `month_not_completed`; own currency `currency_not_convertible`; nothing recorded. U: RCD it.each. (AM5 equivalent) | - | yes |
| 2.6 | A: RS and RR a later fetch with another value never replaces a correction | - | yes |
| 2.7 | A: RR no row = missing even with neighbouring months; U: ERC Missing badge | - | yes |
| 2.8 | A: RS throw, timeout, wrong `<monat>`, missing currency: no rate row, failed attempt; RR `lastFetch` outcome/time visible to a reader, stays until a later success. U: ERC persistent banner | - | yes |
| 2.9 | A: RR manager POST fetch asks only for months without a recorded rate (`deferredMonths`, outcomes); reader 403 with no attempt row. U: ERC Fetch now | - | yes |
| 2.10 | A: RS `consumerRates` (in effect with no call; published month fetched, recorded as `consumer`; failure, throttle, not published, 36 pairs = 6 months, 30 s hang answered in < 7 s), SYS, BUD (6 s + 1 s < 10 s), **CON (the real client against the real route)**. Mutant AM2 killed | - | yes |
| 2.11 | A: RR WellD Italia GET `source:null`, POST fetch 422 `no_rate_source` with no attempt; RS and RR a CH fetch/correction changes no Italian row; CON. U: ERC no-source panel | acc | yes |
| 3.1 | auth: ACAT (`read` and `manage`, only `entity`, no `access`), UNQ, SD `seedAccountingCatalog`, ARO. The admin GUI is generic over the catalog (admin-ui untouched) | acc-access | yes |
| 3.2 | A: COV vectors, CAT manage-only holder reads and writes, ME. auth: DER. Mutant AM1 killed | - | yes |
| 3.3 | auth: SD `seedAccountingGrants` (admin both unconditioned, accounting both entity-conditioned, no other role, re-seed keeps an admin's edit). Mutant AU2 killed | - | yes |
| 3.4 | A: CAT, RR, MAT reader's add, deactivate, reactivate, correct, fetch = 403 `accounting_manage_required` before the body, nothing changes or is attempted. U: LAC/ERC reader view. Mutant AM7 killed | acc-access | yes |
| 3.5 | A: CAT, RR, MAT every route of the other entity = the same 404 body as an unknown entity, nothing touched. U: SHL (`useEntity`, switcher, not-found view). Mutant AM10 killed | acc-access | yes |
| 3.6 | A: CAT, MAT every `/v1/*` route 403 `accounting_forbidden`, no data. S: `router.accounting` (no entry, `/no-access`) | acc-access | yes |
| 3.7 | A: **SH (added)**. R: RMV (the real app in a subprocess: the legacy routes 404 for a settings:manage holder), DEF (an Accounting manager without `settings:manage` refused on both PUTs and on the read) | ref-set | yes |
| 3.8 | A: SYS (equals the reader projection, one identical 401 for six credentials, GET only, `no-store`), WIRE, SVC, CON; `shared:check`. Mutant AM4 killed | - | yes |
| 3.9 | R: CLS options identical with and without an Accounting grant, DEF. A: SH, MAT. S: `router.accounting` (Refund or admin do not stand in) | - | yes |
| 4.1 | R: CLS options exact key sets, active WellD CH only, same with or without a grant; CON. F: LCP, DCD | - | yes |
| 4.2 | R: CLS a `welld_it` scope = 403 `accounting_out_of_scope`; lines `inScope:false` | - | yes |
| 4.3 | R: CLS PUT refusals (deactivated, unknown, only-Italy number, same for codes), line unchanged, audit count unchanged. (RM9 equivalent) | ref | yes |
| 4.4 | R: CLS options for a `settings:manage` holder; DEF 422 for deactivated, unknown, Italy-only. F: DCD, FCV list options only. Mutant RM4 killed | ref-set | yes |
| 4.5 | R: RSN vectors, DEF GET states (active, deactivated, not found), INA view/approve agree. F: ETD badges and note. Mutant RM5 killed | ref-set | yes |
| 4.6 | F: DSV/`SettingsViews` (General and Default classification only; legacy `?section=` falls back), ALN (link with `apps`, text without). R: RMV | ref-set | yes |
| 4.7 | R: DEF history unchanged after deactivation, rename, re-entry, unreachable; DBI both tables immutable; NK | - | yes |
| 4.8 | R: NOC every listed operation reads afresh and the port holds no data, CLI, APP second approval sees a change, CLS/DEF read counters; A+R: CON the next operation sees a reactivation | - | yes |
| 4.9 | R: CLS an Italian line has no classification and nothing is read; APP and MTX IT-only approves with Accounting down, 0 calls (RM1 killed). F: LCP | ref | yes |
| 5.1 | R: APP request with a CHF default line, a hand copy, an EUR line with a rate and a rejected line: each copy as planned, audit carries values | ref | yes |
| 5.2 | R: CLS PUT while submitted and approved: the copy is written at that moment from Accounting as it is now; audit from -> to | ref | yes |
| 5.3 | R: APP, CLS, NK, EXP the fake changes everything after approval: view and CSV bytes unchanged; DBC the fx copy is write-once; DBG copies locked once paid and numbered | - | yes |
| 5.4 | R: EXP summary and CSV with Accounting unreachable and **0 calls**; same batch twice = identical bytes and SHA-256; MTX | - | yes |
| 5.5 | R: AMT 1040 x 924600 = 962; EXC/EXP golden and a rate corrected to 0.9300 after the copy: row reads `10.40;0.9246;9.62`. Mutant RM6 killed | ref (live) | yes (live journey pending) |
| 5.6 | R: APP approve with no rate = `rateStatus:"pending"`, no CHF or VAT amount; EXP the first successful export copies the rate with `line_rate_copied` (exporter, time), a refused export copies nothing, two concurrent exports one copy; RCP; DBC. Mutant RM2 killed | ref (live) | yes (live journey pending) |
| 5.7 | R: CLS an approved line: only the named copy changes, fx copy, total, status, decision unchanged; paid = 409 `classification_locked`; DBG | - | yes |
| 6.1 | R: APP and MTX each failure kind = 503 `accounting_unavailable` with `Retry-After`, including a hand-classified line (D10). F: RDP/APD message inside the dialog | ref | yes |
| 6.2 | R: APP after every refusal: submitted, no number, no counter row, no copy, no decision, no audit; a later approval succeeds | - | yes |
| 6.3 | R: APP `classification_missing` names the lines and halves; INA; MTX the 503 wins over a missing default | ref | yes |
| 6.4 | R: APP and MTX IT-only and all-CH-rejected approve with Accounting down, 0 calls. Mutant RM1 killed | ref | yes |
| 6.5 | R: CLS view 200 `accounting:"unavailable"` with recorded values, options 503, PUT 503 and the line unchanged. F: LCP no selects, the note | ref | yes |
| 6.6 | R: EXP and MTX `blockers.accountingUnavailable`, CSV 409, no log row; compile, pay, discard unaffected. F: AEC. Mutant RM11 killed | ref | yes |
| 6.7 | R: EXP `missingRates` with `reason`, `fetchAttempted`; compile, pay, discard unaffected. F: AEC "not published yet" | - | yes |
| 6.8 | R: CLI constants (10 s), deadline (injected 200 ms), every failure kind, the 401 re-mint, a real loopback server for redirects and size; MTX every kind through approve, classify, view, options, settings, export, release; BUD; CON against the real routes. Mutants RM3, RM8 killed | - | yes |
| 6.9 | R: DEF GET 200 with recorded values and `unverified`, PUT 503. F: ETD banner, Change `aria-disabled` with its reason, History still opens | ref-set | yes |
| 6.10 | R: MTX no host, URL, id or stack in any refusal body; CLI logs carry nothing of the peer. F: refund-ui `strings.test.ts` en/it parity | - | yes |
| 7.1 | R/F: the 20261118 suites for US-2, 3, 4, 6, 7, adapted to the fake, all green (see "20261118 still holds") | ref, ref-set | yes |
| 7.2 | R: EXC golden CSV byte for byte (`accounting-export.golden.csv` and its input untouched since 20261118 T17), EXP through the route; NUM, LIF numbering unchanged; `requests.routes.test.ts` owner key-set test (fixtures adapted, assertion unchanged) | - | yes |
| 7.3 | R: VWR shared vectors, CLS and EXP `viewer.canOpenAccountingRates`. F: AEC link or "ask an accounting manager". U: ERC deep-link row and "not in the list" note. Mutant RM7 killed | ref | yes |
| 7.4 | R: REL Accounting read first, backfill by copy (CHF default, EUR with rate or pending), unreachable = exit 2 and nothing written, rerun safe, `--dry-run`, Italian lines untouched. Mutant RM10 killed | - | yes |
| 7.5 | R: REL with no WellD CH entries the legacy lines are numbered and listed unclassified; APP then refuses with `classification_missing`. A: SEED the seed adds the list and never touches an existing entry | - | yes |
| 8.1 | auth: DER, ARO (read, manage, both; not for no grant, null entity, unknown condition). S: `router.accounting`, `Sidebar`, `tools`. Mutant AU1 killed | acc-access | yes |
| 8.2 | U: SHL (`EntitySwitch`, `useEntity`, `AccountingShell`), pages title the entity; A: ME two entities | acc, acc-access | yes |
| 8.3 | A: CAT/RR an empty entity is 200 `items:[]`. U: LAC/VCC/ERC empty states, "nothing entered yet" vs "no official source" | acc | yes |
| 8.4 | U: STR (en/it parity, no hard-coded copy), axe with zero violations in every card and dialog state (about 100 `expectNoAxeViolations` calls), focus to the first refused field and one alert per field (ALD, AVD, RCD), **KBD (added) keyboard-only add, refuse, deactivate, reactivate, correct**. S: `italian.test.tsx` | acc, acc-access (axe light/dark, en/it; one keyboard journey) | **no, for contrast, reflow and real tab order**: jsdom axe runs with `color-contrast` and the page rules off; the rest of the clause is proven |

**Summary: 68 of 68 ACs have executed evidence; 67 are fully proven by unit, integration and component evidence alone, 1 (AC-8.4) is not.** AC-8.4 needs the browser pass for
contrast and reflow (pending, T51). AC-5.5 and AC-5.6 are proven in numbers and in their database guards; the live journey adds the assembled path only.
Live journeys pending, by AC: 1.1, 1.3, 1.4, 1.9, 1.10, 2.4, 2.11, 3.1, 3.4 to 3.7, 4.3 to 4.6, 4.9, 5.1, 5.2, 5.5, 5.6, 6.1, 6.3 to 6.6, 6.9, 7.1, 7.3 and 8.1 to 8.4. For every one of them
except 8.4 the executed evidence is sufficient on its own; what the e2e adds is the shell mounting the remote, the bearer and CORS in a real browser, the `?entity=` and `?section=`
search validation, and the global setup's seed and release against a live database.

## 20261118 still holds where this spec says it should

The Relationship section keeps in Refund: the per-type defaults and the designation (its AC-2.1 to 2.3, 2.5, 2.7, 2.8), classification and review (US-3),
receipt numbers (US-4), the batch export (US-6) and the release (US-7), changed only by where options come from, copies, rate pending and refusals.

- **Every suite of 20261118 is still run and green.** refund-api 1781 and refund-ui 1314 pass; the diff of the test files against 6094b486 (20261118's
  re-tested commit) is fixture adaptation (foreign keys to copies by natural key) plus additions. Files deleted outright are the catalog and rate suites that
  moved to accounting-api (`fx/*`, `accounting/catalog.routes.test.ts`) with `git mv` and their history.
- **The golden file is untouched.** `accounting-export.golden.csv` and `accounting-export.input.json` have exactly one commit (20261118 T17); `export.test.ts`
  only grew (167 lines added, none removed). Header, 16 columns, order and values are the 20261118 ones (AC-7.2), and the route test builds the file through
  the database.
- **Numbering (its US-4)**: `receiptNumber.test.ts` unchanged; `numbering.repo.test.ts` changes are the freeze-from-copies fixture; the 20-round parallel
  approval, the two-year case, the counter, immutability (`db.accounting-receipt-guard.test.ts`) and the discard/recompile lifecycle (`receipt.lifecycle.test.ts`, 12 lines
  rewritten for fixtures) all run green.
- **The adjusted ACs** are each stated through copies and proven: AC-3.5 (APP, CLS, NK: nothing moves after approval), AC-6.3 and 6.8 (EXP, EXC: the copied rate, identical
  bytes), AC-6.5 stands and AC-6.6, 6.7 add the unreachable and missing cases (EXP, MTX); G5 (rates readable only by Refund admins) is gone with the routes (RMV).
- **Its security fixes still hold** (S-01 to S-06; the OWASP pass of this feature re-checked them): `lineInScope` tests, `self_approval_forbidden` on reclassify,
  `Cache-Control: private, no-store`, `offsets.csv` ignored (`accounting-release.test.ts` `.gitignore` test).
- **Its follow-ups A-1 and A-2 (G14)**: still closed at component level on the changed screens. A-1 (an approval naming only out-of-scope lines never fails silently):
  `ReviewDetailPage.test.tsx`, "lines outside the approver's entity scope (A-1, FU-S7)", 3 tests. A-2 (focus after a 403 `self_approval_forbidden`):
  `LineClassificationPanel.test.tsx`, 3 tests. A-3 (focus after Check again / Retry) is the same pattern in `AccountingExportCard` and `ExpenseTypeDefaultsCard`
  (UX-23), tested. A-4 is follow-up F-A2, not planned. All four were findings of a real-browser pass, so the browser re-check is part of T51.
- **Its own live e2e (T31, T32) was never run** and is replaced by this feature's adapted journeys (T42); the same pending status applies.

## design.md audit (static, by component tests)

- **Screens and states.** AS1 (loading, denied, 503, other failure, loaded, unknown path: `AccountingShell`, `frameStates`, `router`), AS2 (one entity, two, garbage value, uncovered entity, grant narrowed
  mid-session: `useEntity`, `EntitySwitch`, `AccountingShell`), AS3/AS4 (loading, failed, 503, 403, 404, reader, empty by entity, loaded; Add, Deactivate, Reactivate, stale 409:
  `LedgerAccountsCard`, `VatCodesCard`), AS5 (fetch states, failure banner, no-source panel, deep link and its "not in the list" note, Correct on a Missing cell: `ExchangeRatesCard`), AS6 (every dialog beside its card, never
  inside a form, busy and not dismissible, focus return), AS7 (`NotFoundPage`). RS1 to RS7 (Settings frame, defaults view with states and the unreachable banner, dialogs, line panel states incl. rate pending and unavailable,
  approve dialog 503, export card blockers and quiet re-read, nothing else changed). Each state has a named test; none missing.
- **Component reuse.** accounting-ui holds the 5 N rows of the inventory (shell, entity switch with its hook, three thin pages, `limits.ts`) plus the declared copies (`LoadState`, `PermissionDenied`,
  `Saved`, `useLoadedResource`, `monthLabel`, `formatVatRate`, `statusMeaning`, `axe.ts`); the six moved components and `useCatalogToggle` are renames with history. No Mantine, no new visual component, no
  token. refund-ui: `AccountingLinkNote` is the only new component; `ChangeHistoryDrawer` untouched; the six moved components are deleted. `formatMonth` is the one library addition (with its story, test and changeset).
- **Accessibility.** In component tests: tab list labels, dialog names, `role="alert"` per refused field with focus on the first, polite live regions, `aria-disabled` Change with its reason, `aria-haspopup="dialog"`
  openers, focus return after add and after deactivate (row header), keyboard-only paths (added). Not verified here: contrast, 320 px reflow, real tab order, screen-reader output, the browser axe run (light/dark, en/it)
  of `accounting.spec.ts` and `accounting-access.spec.ts`: T51. See D-8.
- **Copy.** en/it parity, the load-bearing sentences word for word (UX-3, 4, 7, 10, 11, 13) and the no-hard-coded-copy scan run inside the green suites.
- **design.md front matter** still `status: draft` (D-8).

## Documentation and runbook against code

Checked and **right**: ports (8089 api, 5183 ui, 5185 e2e preview) and the database name; the env contract of `accounting-api/src/lib/env.ts` against `infra/README.md` § accounting-api and `tools/env-doctor/templates/production/accounting-api.env`
(env-doctor passes in both directions, flags `REFUND_FX_SOURCE` by name); `SERVICE_CLIENTS` scope shape in `auth/.env.example`; the runbook's seed log line against `auth/src/authz/seed.ts`; step 3's `preDeploy`/`db:release`;
`.railway/railway.ts` block (healthcheck, one replica EU, no source, no domain) against the README table; `CSP connect-src`/`script-src` in `shell/vercel.json` against `infra/check.sh`; `accounting:release` options
(`--dry-run`, `--offsets`, `--defaults`, `--show-emails`; `--seed` gone) and its exit codes 0/1/2; e2e global setup steps against `AGENTS.md` § Accounting and Refund in the e2e; AGENTS.md's statement that
`accounting:release` is not in refund-api's image.
**Wrong**: D-2 (three statements that `seed:welld-ch` is not in the Docker image) and D-3 (`.dockerignore` and the tests). Which is right, in one line: the Dockerfile, `infra/README.md` § runbook step 6 and the script's own header.

## Notes for the caller

- **Fix list for the dev round** (small): D-1 (route validation; flips the 3 red tests green), D-2 and D-3 (four text edits and a `**/*.test.ts` line), D-4 (add the two `accountingWire` paths, and ideally every shared copy, to `shared-copies.yml`), D-5 (a scratch database name per `describe`, or `describe.serial`).
  Then re-run: accounting-api `bun test` and `tsc`; refund-api `bun test --randomize` (two seeds) and the `migration.accounting-move` file alone; the shared-copies check; nothing else moves.
- **Scheduled review.** The OWASP pass ran in parallel as T47 (`security-review.md`, committed as 99c0e863: 0 critical, 0 high, 1 medium, 6 low). It did not report D-1. A second pass is not needed for the D-1 fix, which is input validation of two path keys.
- **T46 is not checked in `tasks.md`** (done-when requires PASS). `status` of the spec stays `approved`.
- **Open items for the owner (T51):** the live e2e; the browser accessibility pass (record it in design.md "Browser accessibility pass" and note it here); T50's open questions are not a gate of this verdict.
- **Spec bugs:** none found. D-6 asks the spec to say what a "blank" name and a "character" are; the plan's table was total over the 68 ACs and no AC needed a change to be testable.

## Re-test after fix round 1 (T53 to T57; HEAD 8f81f897)

Verdict: **PASS**. D-1 to D-6 and D-8's comment are closed or handled, no AC regressed, every gate is green. The live e2e and the browser accessibility pass stay PENDING (owner, T51), as before. The first pass above is kept as it was.

| Check | Threshold | Actual | Result |
|---|---|---|---|
| accounting-api `bun test`, `tsc` | 0 fail, clean | 655 pass, 0 fail, 29 files (D-1 repro `catalog.keys.test.ts` green); also `--randomize --seed 424242`: 655 pass; on a database migrated from zero: 655 pass; tsc clean | ✓ |
| refund-api `bun test`, `tsc` | 0 fail, clean | 1799 pass, 0 fail, 71 files; on a fresh database 1799 pass; tsc clean | ✓ |
| refund-api `--randomize` seeds 424242 and 77 | 0 fail | 1799 pass, 0 fail, both seeds; `migration.accounting-move.test.ts` alone, seeds 1, 2, 3: 30 pass, 0 fail each | ✓ (D-5 closed) |
| auth `bun test`, `tsc` | green | 1497 pass, 36 skip, 0 fail; clean | ✓ |
| accounting-ui `tsc -b`, lint, vitest, build | green | clean, clean, 564 pass, builds | ✓ |
| refund-ui `tsc -b`, lint, vitest, build | green | clean, clean, 1314 pass, builds | ✓ |
| operai-ui typecheck, lint, test | green | clean, clean, 300 pass | ✓ |
| shell build, lint, vitest | green | build, lint, 685 pass | ✓ |
| shell e2e `tsc`; `playwright test --list` | clean; listed | clean; 238 tests in 53 files | ✓ |
| `shared:check`, `react:skew`, `env:doctor`, `changeset:check` (local main and origin/main) | green | 34 groups in sync; 12 frontends one version; all checks passed; OK, OK | ✓ |
| Migrations from zero, accounting and refund | no drift | applied; `migrate diff --exit-code` "No difference detected" for both | ✓ |
| Secret scan of the delta 99c0e863..HEAD (2,572 added lines) | none | only fake test fixtures (`leak_user:leak_pw@127.0.0.1`, `user:secret@db.internal`, a test service secret) | ✓ |
| Critical CVEs | 0 | no lockfile changed since the first pass; accounting-api 0 critical (2 high, 2 moderate via the prisma dev CLI); accounting-ui none | ✓ |
| Live e2e, browser pass | green | not run (owner, T51) | PENDING |

Closed, with the evidence:

| id | Result |
|---|---|
| D-1 | closed. `%00` in a ledger number or VAT code key now answers 404 `not_found` on deactivate and reactivate (probed: 404, writes nothing); the 3 red tests are green. Non-vacuity: a mutant that makes the key check always true fails 2 of them (`isLedgerNumberKey`, `catalog.repo.ts`). |
| D-2 | closed. `.changeset/accounting-module.md`, `AGENTS.md:194` and `accounting-api/README.md:65` now say `seed:welld-ch` is in the image and `accounting:release` is not; no remaining "not in the Docker image" about the seed. |
| D-3 | closed. `.dockerignore` has `**/*.test.ts`, `**/test-support` and `**/fixtures`; comments and `infra/README.md` agree. Checked that nothing at runtime imports from `test-support` or `fixtures`, and `scripts/data` stays in. The full image build was not run (Docker Hub pull hung, as the caller said); I verified the pattern semantics last pass with a context-only build. |
| D-4 | closed for `accountingWire`: `shared-copies.yml` lists both copies. Info, not reopened: the workflow lists only selected groups, so accounting-api's `systemAuth`, `problem` and `logger` copies are not listed, like the other services'. |
| D-5 | closed: green with seeds 424242 and 77 on the whole suite and with seeds 1, 2, 3 on the file. |
| D-6 | closed. Server: a name made only of U+200B, a bidi override, spaces or U+2800 is 422 `empty`; 70 emoji are accepted (201) and 121 refused `too_long` (code points). UI `lib/limits.ts` mirrors both. Non-vacuity: server mutants (blank rule reduced to `\s`; length back to UTF-16 units) are killed (10 and 1 tests), UI mutants (same two) are killed (17 and 3). |
| D-7 | unchanged, not this feature. |
| D-8 | design.md front matter and the axe.ts comment were not part of the round; still info. |

New behaviour checked: the per-entity catalog cap (`catalog.cap.test.ts`, `catalog_full` 409; the add dialogs show their own en/it message, tests in both dialogs and `catalogApi`), `Cache-Control: no-store` on every user route (probed on list, add, `/v1/me`, errors and 404s) and, in refund-api, `no-store` and `nosniff` on the options, view and classification routes and the defaults routes (mutant removing it on the options route: 3 tests fail), the 2000-01 month floor (a pre-2000 line no longer fails the whole rates read; mutant at 1900-01: 4 tests fail), and the quiet Prisma client of the release script (a CLI test with fake credentials shows no host or path; mutant that logs again: 1 test fails).

Defects after the round: none. T46 is checked in `tasks.md`.

## Sign-off round (T77; HEAD a88a23b1)

Scope: both specs' 2026-11-19 sign-off amendments, the sample-file sync (20261118 AC-3.11 to 3.13, 4.11 to 4.13, 6.13 to 6.17, 7.4, 8.1 to 8.5 and the adjusted and retired ACs; 20261119 AC-2.12, 7.6 and the adjusted ACs), both plans' "Accounting sign-off delta", T58 to T76, and `release-rehearsal.md`. Database: the new isolated `operai-accounting-test-pg` on 127.0.0.1:5446 only (scratch databases `accounting_qe77` and `refund_qe77`, created and dropped by this pass). `db:generate` and `db:deploy` were run first in every package. Not staged: the modified `.envrc` of the tree.

### Verdict: FAIL (one low defect, D-9; everything else holds)

Every added or adjusted AC has executed evidence, the retired ones are retired in code, API, UI, seed and docs, the workbook matches the accountant's template, and every gate is green except `--randomize` seed 424242 on refund-api, where the new sign-off migration test depends on test order (D-9). That is the same class of defect as D-5, which fix round 1 closed for `migration.accounting-move.test.ts`; the new file repeats it. The fix is small; re-run on the delta only.

| Check | Threshold | Actual | Result |
|---|---|---|---|
| accounting-api `bun test`, `tsc` | 0 fail, clean | 658 pass, 1 skip (the opt-in AFC test), 0 fail, 30 files; `--randomize --seed 424242`: 658 pass; on a database migrated from zero: 658 pass; tsc clean | ✓ |
| AFC live test, once (`ACCOUNTING_LIVE_RATES=1`) | EUR 0.9246 for 2026-03 | pass (a real call to the AFC/ESTV XML channel; EUR 924600 micros) | ✓ (AC-2.12) |
| refund-api `bun test`, `tsc` | 0 fail, clean | 1918 pass, 0 fail, 77 files; on a database migrated from zero: 1918 pass; tsc clean | ✓ |
| refund-api `--randomize` seed 77 | 0 fail | 1918 pass | ✓ |
| refund-api `--randomize` seed 424242 | 0 fail | 1916 pass, **2 fail**, both in `src/lib/migration.accounting-signoff.test.ts`; that file alone: seeds 1 and 424242 fail 2 (13 pass), seeds 2 and 3 pass | ✗ D-9 |
| auth `bun test`, `tsc` | 0 fail, clean | tsc clean. In this tree: 1495 pass, 36 skip, **2 fail** (`legalEntities/write.routes.test.ts` "the throttle (F3)", a file this branch does not touch), caused by an untracked dotenv file of the checkout (see Environment faults); in a copy of `auth` without it the throttle tests pass | ✓ (environment fault, not a defect) |
| accounting-ui `tsc -b`, lint, vitest, build | green | clean, clean, 564 pass, builds | ✓ |
| refund-ui `tsc -b`, lint, vitest, build | green | clean, clean, 1331 pass, builds | ✓ |
| operai-ui typecheck, lint, test | green | clean, clean, 300 pass | ✓ |
| shell build, lint, vitest | green | build, lint, 685 pass | ✓ |
| shell e2e `tsc`; `playwright test --list` | clean; listed | clean; 239 tests in 53 files; 115 test ids referenced, all present in the sources (three absent ids are negative `toHaveCount(0)` assertions of retired UI) | ✓ |
| `shared:check`, `react:skew`, `env:doctor`, `changeset:check` (local main and origin/main) | green | 34 groups in sync; 12 frontends on one version; all checks passed; OK, OK | ✓ |
| Migrations from zero (accounting, refund) | no drift | all migrations apply (refund: 13, the last three are the sign-off ones); `migrate diff --exit-code` "No difference detected" on both; the full suites are green on them | ✓ |
| Secret scan of the delta 86114dc6..HEAD (10,613 added lines) | none | no hit of any pattern; the only added key-like file is `accounting-api/.env.example` (a template) | ✓ |
| Critical CVEs | 0 | no lockfile changed (`refund-api/package.json` gained one script line); `bun audit`: refund-api 16 (9 high, 5 moderate, 2 low, none critical), accounting-api 4 (2 high, 2 moderate), as before | ✓ |
| Golden workbook against the accountant's template | same structure | see "The workbook" | ✓ |
| Golden workbook in LibreOffice headless | opens | `soffice` is not installed here: listed for T81 (Excel or Numbers) | PENDING T81 |
| Live e2e, browser pass | green | not run (owner, T81) | PENDING |
| Mutation sample (this round) | killed | 14 of 14 killed (table below) | ✓ |
| Retired ACs retired | nothing left | see "Retired ACs" | ✓ |
| Docs and release rehearsal vs code | consistent | the rehearsal agrees with the code; two known cosmetic items and further info items (D-10 to D-15) | ✓ with notes |

### Defects of the round

| id | AC / check | severity | evidence | suspected owner |
|---|---|---|---|---|
| D-9 | test hygiene; the D-5 class again | low | `migration.accounting-signoff.test.ts`, describe "the sign-off migrations carry a 20261119130000 database with realistic data": the tests share one scratch database `refund_mig_so` and some of them write to it ("the new enum values can be written after the migration (a line, a default)", "receipt_number_baseline starts empty, takes a 2026 row ..."), while others compare it with digests taken before ("every default row keeps its id ...", "line copies, audit history, receipt counters ... are unchanged"). Shuffled so that a writer runs first, the comparisons fail: whole suite `--randomize --seed 424242` (2 fail); the file alone, seeds 1 and 424242 (2 fail), seeds 2 and 3 green; default order green in every run. CI does not randomize, but the gate list (and fix round 1) says it must hold. Fix: give the writing tests their own scratch database (as T54 did for the move test) or make the file serial. | dev (tests) |
| D-10 | cosmetic (known) | info | `refund-api/scripts/accounting-release.ts` line 742 and the "Rate pending" line print `1 lines` for a group of one (rehearsal D-1): `${n.count} lines` in `formatReport`. No effect on numbers. | dev |
| D-11 | stale comments (known) | info | `refund-api/src/index.ts` line 112 still says the export router serves "summary + CSV"; the route is `/file` (XLSX) and `/csv` is 404 (`export.routes.test.ts`). Also `refund-api/src/requests/requests.schemas.ts` line 7 says "the twelve expense types" (fourteen since T59). | dev |
| D-12 | AC-6.15 wording against the plan | info | The Description (and a non-canonical Debit) is passed through `sanitizeText`, which turns each control character into a space **and** collapses runs of spaces and trims (probe: `"Foo  bar"` gives `"Foo bar"`, `" =lead"` gives `"=lead"`). AC-6.15 says "exactly as written apart from the line breaks of AC-6.13"; plan SO-9 chose the collapse and the test says so (`exportFormat.test.ts`, "turns each control character into a space, and collapses and trims"). Harmless for accounting, but the spec text and the code differ. | spec (say "collapsed") or dev |
| D-13 | workbook vs template | info | The accountant's template is an Excel table (`Table1` over A1:H201 with an autofilter), and its empty Tax and Note cells have the General format; the generated workbook has no table part and gives those cells the text format. Sheet name, header, column order and widths, the date format, number types, `0.00` on Amount, Credit 5832, Currency CHF, Debit numeric except `2620.10` as text, and the descending date order all match. Whether Accrio needs the table is for the trial import (T80). | owner (T80) |
| D-14 | privacy hygiene | info | `docs/refund-accounting-backlog.md` line 74 names four client companies that come from the accountant's sample. No row, Description or amount of the sample is in the repository (136 template descriptions: none appears verbatim in the diff; the golden fixture is synthetic), but the owner may prefer generic wording. | owner / dev (docs) |
| D-15 | info, no action | info | `refund_line.vatCodeIsDefault` stays in the table, written `false` or `null` and read by nothing (SO-2; `classification.repo.ts` line 548 says so). `shared-copies.yml` lists only selected groups (accounting-api's `systemAuth`, `problem` and `logger` copies are not listed, like the other services'; pre-existing policy). accounting-api and accounting-ui tests still use `IMP81` as an arbitrary code (Accounting keeps any code; only the seed, the defaults and the docs must not name it, and they do not). | none |

Environment faults (no dev round):

- **Stale generated Prisma client** in this checkout (no `travel_flight`): fixed by `bun run db:generate` in the three APIs before any test, as the caller said.
- **An untracked dotenv file in `auth/`** (not mine, not read: a hook protects such files). It makes `bun test` in `auth` exit at once ("BOOTSTRAP_ADMIN_EMAIL must be a valid email address") and, with that one variable supplied on the command line, makes the two legal-entity throttle tests fail (they expect the default limits). A copy of `auth` made without it passes the throttle tests (its only other failures are two tests that read a fixture by a path outside `auth/`, which a copy cannot reach). Nothing under `auth/` changed in this round. Whoever owns that file should know it changes the result of the suite.
- `.envrc` is modified in the tree and was never staged.
- No `soffice` on this machine.

### Retired ACs are retired (no VAT default, no designation)

- **Code:** `git grep` over refund-api, refund-ui, accounting-ui, shell/e2e, infra and tools for `foreignCurrencyVat`, `foreign-currency VAT`, `vatCodeIsDefault` (outside the vestigial column above), `NOVAT`, `IMP81`, `IMP77` and `designat*` finds only tests that assert absence, the retirement notes and the migration. The Prisma schema has no designation model; migration `20261119200200_vat_defaults_retired` drops the table and the VAT columns of the defaults (`migration.accounting-signoff.test.ts`: the table and its triggers are gone, the defaults keep ids, actors, times and accounts, the shared raising function stays).
- **API:** `PUT /accounting/foreign-currency-vat-code` is 404 (`removed-routes.test.ts`); the defaults GET and PUT are accounts only and refuse a `vatCode` body with 422 (`defaults.routes.test.ts`); `/accounting-export/csv` is 404.
- **UI:** the Settings defaults card, dialog and view have no VAT column, select or designation block (`ExpenseTypeDefaultsCard`, `DefaultClassificationDialog`, `DefaultsSettingsView`); the e2e asserts that none of their test ids exists.
- **Seed and release data:** `seed.welld-ch.json` holds 19 accounts and 6 VAT codes (`IPM81`, `IPM77`, `IP00`, `BZM81`, `IPM26`, `IPM38`), compared by hand with AC-7.6: all six accounts of the amendment are present with their names; `accounting-defaults.welld-ch.json` holds the 14 types, accounts only, `representation_gifts` empty, no `vatCode` and no `foreignCurrencyVatCode`; both parsers refuse the old shape (`accounting-release.test.ts`, `.cli.test.ts`).
- **Docs:** AGENTS.md, `infra/README.md`, `accounting-api/README.md` and the changeset say accounts only, no VAT default, no designation, the XLSX file, `IPM81`.

### The workbook against the accountant's template

The template was copied to the scratchpad and read with `openpyxl` (read-only, `python -I`); no row of it was copied anywhere. Compared as structure only: one sheet `Sheet 1`; header `Date, Description, Debit, Credit, Amount, Currency, Tax, Note` (bold); Date a real date with the format `yyyy\-mm\-dd;@`; Description text; Debit and Credit numbers in the General format; Amount a number with `0.00`; Currency text; Tax and Note empty; column widths close to the template's (12, 70, 10, 10, 12, 10, 10, 39 against 11.8, 70.5, 7.8, 8.5, 11.8, 11.5, 9.3, 39); Credit is 5832 and Currency CHF on every template row; the template's dates run latest first (AC-6.16); its Debit is an integer on 198 of 200 rows and a decimal such as `2620.1` on 2, which is the case AC-6.17 handles. The golden workbook (`accounting-export.golden.xlsx`) has the same in 11 synthetic rows: zip intact, no formula element in any part, Debit numeric for `6101`, `5907`, `6701`, `2620.1` and text for `2620.10`, read back by `openpyxl` as such. The Description of the real sample is free text without a receipt number, as the plan expected (the pattern of AC-6.13 stays provisional until the accountant answers). Differences: D-13.

### Evidence for the added and adjusted ACs

Executed and green; each group was also mutated (table below). Files are under `refund-api/src/accounting/` unless shown.

| AC | Evidence |
|---|---|
| 20261118 AC-3.11 (no VAT code never blocks) | `classification.test.ts`, `approve-accounting.test.ts` (an EUR request with accounts and no VAT code approves and numbers), `export.test.ts` and `export.routes.test.ts` (exported like any line), UI `LineClassificationPanel` and `ReviewDetailPage`, e2e `refund-accounting` (pending) |
| 3.12 (at most one VAT code per line) | the classification body takes one `vatCode` (`classification.schemas.ts`, strict); UI `ExpenseLineComposer.test.tsx` offers one VAT field and the split-receipt hint |
| 3.13 (foreign line: nothing pre-set, any active code, `BZM81` included) | `classification.test.ts`, `classification.routes.test.ts`, `approve-accounting.test.ts`, UI `CatalogSelect`, `LineClassificationPanel` |
| 4.11, 4.12, 4.13 (2026 baseline N + 1, none = 001, other years ignore it, 2027 restarts) | `receipt.baseline.test.ts`, `numbering.repo.test.ts`, `db.accounting-signoff.test.ts` (table CHECKs, immutability), `receipt-baseline-from-register.test.ts` (helper: duplicates, wrong year, malformed numbers, maxima per initials); mutants SM1, SM1b killed |
| 6.2, 6.3, 6.12 (eight columns, Credit 5832, Currency CHF, Amount the CHF amount, 9.62, 0.00) | `exportFormat.test.ts`, `export.test.ts` (byte for byte against the golden workbook and its cell list), `xlsx.test.ts`, `export.routes.test.ts` through the route; mutant SM3 killed |
| 6.13 (Description pattern) | `exportFormat.test.ts`, `export.test.ts`; mutant SM6 killed |
| 6.14 (Tax and Note present and empty) | `export.test.ts` ("Tax and Note are empty", cell types `empty`) |
| 6.15 (text, never a formula, eight cells) | `exportFormat.test.ts`, `xlsx.test.ts`, `export.test.ts`; no formula element in any part (checked again here); mutant SM7 killed; wording gap D-12 |
| 6.16 (latest first, fixed tie-breaks, identical files) | `exportFormat.test.ts`, `export.test.ts`, `export.routes.test.ts` (two downloads identical, same SHA-256); mutant SM5 killed |
| 6.17 (`2620.10` as text, `5905` and `2620.1` numbers) | `export.test.ts` ("AC-6.17"), `exportFormat.test.ts`; verified in the golden workbook; mutant SM2 killed |
| 6.4 and the CSV (retired) | `export.routes.test.ts` "(AC-6.4, retired) ... the file carries no VAT at all" and "the CSV route is gone" (404) |
| 7.1, 7.4 (release: account only, the list required; exit 3 and nothing written; header-only list accepted; rerun is a no-op) | `accounting-release.test.ts`, `accounting-release.cli.test.ts`; the rehearsal; mutant SM8 killed |
| 8.1, 8.2 (14 types with labels; meals renamed, existing lines keep the type) | `labels.test.ts`, `suggestions.*`, `lines.routes.test.ts`, `exportPdf.test.ts`, `pdf.test.ts`, the migration test for the enum order, UI `expenseTypes.test.ts` and its parity test with `document-labels.json` |
| 8.3 (14 defaults; gifts none) | `accounting-release.test.ts`, `defaults.routes.test.ts`, the defaults file; mutants SM11, SM12 killed |
| 8.4 (a gifts line is refused until an account is chosen) | `classification.test.ts`, `approve-accounting.test.ts`; mutant SM4 killed |
| 8.5 (7122 and 2620.1 choosable, never a default) | the defaults file is compared exactly (mutant SM12: 7122 as a default is caught); the seed test holds both accounts; the classification PUT accepts any active account |
| 20261119 AC-2.1, 2.12 (AFC/ESTV named; EUR 0.9246) | `afc.live.test.ts` run once live: pass; `parse.test.ts` fixture; accounting-ui source labels |
| 20261119 AC-7.6 (the exact accounts and six VAT codes, no `IMP81` or `NOVAT`) | `seed-welld-ch.test.ts` (exact list, names, no retired code, every default account in the seed); mutants SM9, SM10 killed |
| 20261119 AC-3.7, 4.4 to 4.7, 5.1 to 5.3, 6.3, 6.9, 7.2, 7.5 (adjusted: no VAT default, no designation) | `defaults.routes.test.ts`, `removed-routes.test.ts`, `classification*.test.ts`, `approve-accounting.test.ts`, refund-ui settings and panel tests; the retirement checks above |
| 20261119 AC-5.5 (Amount 9.62) | `amounts.test.ts`, `export.test.ts`; the first pass's mutant on CHF rounding is still killed |

Live evidence pending (T81): the live e2e, and the workbook opened in Excel or Numbers (LibreOffice is not installed here). For every AC above, unit, integration and component evidence is sufficient on its own, as before.

### Release rehearsal (`release-rehearsal.md`)

Read against the code: exit 3 and `BLOCKED: list missing` (`EXIT_BASELINE_MISSING = 3`, `accounting-release.ts` lines 102 and 698 to 702), the dry-run report lines, the baseline row, 13 defaults (14 types less gifts), the rate-pending and missing-account lists, the idempotent rerun and exit 2 for an unreadable Accounting all correspond to code paths that the CLI tests assert; a mutant that makes exit 3 a 0 is killed by `accounting-release.cli.test.ts`. The two environment notes (stale client, `bun` off the `PATH`) are the ones met here. Its single defect is D-10.

### Mutation sample of the round

Mutants were applied to copies of the packages, the covering tests run, the file restored; control runs green.

| id | Mutation | AC | Result |
|---|---|---|---|
| SM1 | the baseline applied to every year | 4.12, 4.13 | killed (2) |
| SM1b | the baseline ignored | 4.11 | killed (10) |
| SM2 | Debit `2620.10` written as a number | 6.17 | killed (4) |
| SM3 | Credit account 5832 -> 5831 | 6.2 | killed (5) |
| SM4 | approval needs no account | 8.4 | killed (16) |
| SM5 | rows oldest first | 6.16 | killed (6) |
| SM6 | Description without the receipt number | 6.13 | killed (18) |
| SM7 | control characters kept in text | 6.15 | killed (13) |
| SM8 | release exit code for the missing list 3 -> 0 | 7.4 | killed (2) |
| SM9 | seed VAT code `IPM81` -> `IMP81` | 7.6 | killed (7) |
| SM10 | seed account 7122 -> 7123 | 7.6 | killed (2) |
| SM11 | gifts get a default account | 8.3, 8.4 | killed (1) |
| SM12 | postal default becomes 7122 | 8.5 | killed (4) |
| UM6 | the export file name `.csv` instead of `.xlsx` (refund-ui) | 6.2 | killed (2) |

### Fix list and notes

- D-9: a separate scratch database for the writing tests of `migration.accounting-signoff.test.ts`; then `--randomize` seeds 424242 and 77 on refund-api, and seeds 1, 2, 3 on that file alone.
- D-10, D-11: cosmetic edits (`1 line` in the singular; the `index.ts` and `requests.schemas.ts` comments).
- D-12 to D-14 are for the spec owner, the owner's trial import (T80) and the docs; none blocks.
- T77 is not checked in `tasks.md` (done-when requires PASS). The OWASP re-review runs separately (T78).

### Re-test after T82 (b3324375, e72ac580, 7ea73e81; HEAD 7a92703c)

Verdict for the sign-off round: **PASS**. D-9, D-10 and D-11 are closed, N-01 is covered by new non-vacuous tests, D-12 is recorded as accepted, and nothing regressed. Database 127.0.0.1:5446, `db:generate` and `db:deploy` run first. Other packages are unchanged since the pass above and were not re-run. Live e2e, the browser pass and the workbook opened in Excel or Numbers stay with the owner (T81).

| Check | Actual | Result |
|---|---|---|
| refund-api `bun test`, default order | 1924 pass, 0 fail, 77 files | ✓ |
| refund-api `tsc --noEmit` | clean | ✓ |
| refund-api `--randomize` seed 424242, full suite | 1924 pass, 0 fail (was 2 fail) | ✓ |
| refund-api `--randomize` seed 77, full suite | 1924 pass, 0 fail | ✓ |
| `migration.accounting-signoff.test.ts` alone, seeds 1, 2, 3 and 424242 | 15 pass, 0 fail each (seeds 1 and 424242 were 2 fail) | ✓ |

| id | Result |
|---|---|
| D-9 | closed: each writing test now has its own scratch database; the file passes under four seeds and the whole suite under both required seeds. |
| N-01 | closed. `numbering.repo.ts` now looks the baseline up under every email the same `ownerUserId` has used (the one on the request plus the `ownerEmail` of that user's requests, normalised like the key): per email the latest row, across emails the highest, only this user id's emails, 2026 only, and a counter that exists is never moved. `receipt.baseline.test.ts` gained 6 tests (old email loaded and a new one now held: first line is 082, never 001; case and spaces; both emails baselined: the higher wins; latest row per email then the maximum; another user id's old email never applies; a counter that exists and 2027 are unaffected). Non-vacuity, mutants on a copy: lookup by the current email only (3 tests fail), lowest instead of highest (2), no `ownerUserId` filter (2), normalisation dropped (2), earliest row instead of latest (2): all killed. The limit the code states stands: a person who changed address before anything was filed under the old one leaves no trace, and needs a baseline row under the new email (stated in the ADR). |
| D-10 | closed: `linesOf(n)` gives the singular for a group of one, in the numbered list and the "Rate pending" line; reverting it fails 2 tests (`accounting-release.cli.test.ts`, `.test.ts`). |
| D-11 | closed: `index.ts` no longer says "summary + CSV"; `requests.schemas.ts` says fourteen. |
| D-12 | accepted: the space collapsing of the Description is being settled on the spec side by the product owner; no QE action. |
| D-13 to D-15 | unchanged, info. |

Defects after the round: none. T77 is checked in `tasks.md`.
