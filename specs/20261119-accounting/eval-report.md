---
spec: 20261119
evaluated: 2026-11-20
round: 3
task: T79
rubric: default-v2
score: 73.9
verdict: FAIL
round1_score: 75.7
round2_score: 71.3
---
# Eval report: Accounting — one module for ledger accounts, VAT codes and monthly exchange rates

**HEAD evaluated:** `c1e670e3` on `feat/accounting-module`. The diff is `feat/refund-accounting-spec...HEAD`: 90
commits, 372 files, +51,068/−11,602. QE's re-test ran at `8f81f897`. Since then only docs and the trace have changed
(`git diff --stat 8f81f897 HEAD`: the run trace, the migration ADR, `plan.md`, `qe-report.md`, `security-review.md`
and `tasks.md`), so the code QE tested is the code evaluated here.

**Rubric.** The repo has no `gates/configs/eval-rubric.yml`. The synced WellForge plugin
(`~/.claude/plugins/synced/…/wellforge/config/`) ships no rubric file either (only `model-*.yml`). This spec has no
`eval.md`. I therefore applied **default-v2**, as every earlier `specs/*/eval-report.md` does, for example
`specs/20261118-refund-accounting-export/eval-report.md`:

| Dimension | Weight | Floor |
|---|---|---|
| AC satisfaction | 35 | 4 |
| Spec fidelity | 20 | 3 |
| Test quality | 20 | 3 |
| Code quality | 15 | 3 |
| Design fidelity | 15 | 3 (applies: `design.md` exists) |
| Trajectory | 10 | 2 |

`pass_score` is 80. Design fidelity applies, so the total is normalised over 115.

## Verification evidence

I re-ran every suite below myself at HEAD, read-only. I used only the isolated Postgres on :5445, through the env
helpers in the session scratchpad. I did not use :5435, any service, the network or any secret.

| Suite | My result | Matches QE re-test |
|---|---|---|
| accounting-api `bun test` | 655 pass / 0 fail / 29 files | yes (qe-report.md:309) |
| accounting-api `tsc --noEmit` | clean | yes |
| refund-api `bun test` | 1799 pass / 0 fail / 71 files | yes (qe-report.md:310) |
| refund-api `tsc --noEmit` | clean | yes |
| auth `bun test` | 1497 pass / 36 skip / 0 fail / 84 files | yes (qe-report.md:312) |
| accounting-ui `vitest run` | 564 pass / 28 files | yes (qe-report.md:313) |
| accounting-ui `tsc -b` and `eslint .` | both clean | yes |
| refund-ui `vitest run` | 1314 pass / 78 files | yes (qe-report.md:314) |
| refund-ui `tsc -b` | clean | yes |

I did not re-run these, and rely on QE for them: the `--randomize` runs, shell, operai-ui, `shared:check`,
`env:doctor`, `changeset:check` and migrations from zero (all green in qe-report.md:309-321).

- **QE:** the first pass was FAIL at `99c0e863`, with one low defect (D-1) and doc/CI/test-order issues (D-2..D-8).
  The fix round was T53–T57. The re-test is PASS with no open defect (qe-report.md:303-339).
- **OWASP:** the first review was REVIEW REQUIRED (1 medium, F-01). The re-review is PASS: 0 critical, 0 high,
  0 medium, 3 low open and accepted (F-04, F-05, F-06). **Both reviews were static only** (security-review.md, re-review
  § "Updated counts").
- **Not run by anyone, owner step T51:**
  - the live e2e (`cd shell && pnpm e2e accounting refund-`, 238 tests listed, never executed);
  - any real-browser check of the Accounting screens (axe in a browser, contrast, 320 px reflow, real tab order,
    screen reader). See qe-report.md:27-38, :59, :322.
- **CI:** no CI result for this branch could be observed (no network).

## Context weighed

- The owner approved the spec interactively (`154c3f4b`) and chose autonomous execution with no plan gate. The plan
  records this honestly (plan.md:5 `approved_note`), so I did not count the missing plan gate against the run.
- SA-1..SA-3 are honestly marked as agent-made and "owner to confirm" (spec.md:14-27, and inline at the touched ACs).
  This fixes the attribution finding of the 20261118 eval.
- T50 (accounting's sign-off) and T51 (live e2e and browser pass) are owner steps. I did not treat them as defects.
  **Where they leave a behaviour unobserved, I scored it as unverified, not as proven.**

## Scores

| Dimension | Weight | Score (/5) | Floor | vs floor | Weighted | Evidence |
|---|---|---|---|---|---|---|
| AC satisfaction | 35 | 4 | 4 | pass (at floor) | 28.0 | **68/68 ACs have a named, executed, green test** (qe-report.md:168-239), and I reproduced every suite they run in. I traced the AC-critical paths myself: <br>• AC-6.1/6.2/6.4: `readAccountingForApproval` is skipped with no non-rejected CH line, so Accounting is never called. It reads a superset of the pairs before the lock (`decide.repo.ts:370-379`). A line that appears between the read and the lock gives `reference_missing`, which becomes a retryable 409 with nothing written (`:298-305`). <br>• AC-6.8: one `AbortSignal.timeout(10_000)` per operation, one 401 re-mint, `redirect: "manual"`, a 256 KiB cap, and every failure kind becomes `AccountingUnavailableError` (`accountingClient.ts:42-90, 227-340`). <br>• AC-1.3/1.11: an advisory lock plus a unique index, and `FOR UPDATE` on status changes (`catalog.repo.ts:146-153, 251-286`), proven by 20-way `Promise.all` tests (`catalog.routes.test.ts:309-422`). <br>• AC-1.7/1.12/1.13: no-update and no-delete triggers on every catalog and history table (init migration :131-160). <br>• AC-5.6: the pending-rate copy is made at the first successful export; a refused export copies nothing; with two concurrent exports, the first one wins (`export.routes.test.ts:826-943`). <br>**Why not 5:** <br>• **AC-8.4 is not fully proven.** jsdom axe runs with `color-contrast` off, and no browser axe or contrast check of the Accounting screens exists (qe-report.md:237, :239). <br>• The assembled system has never run: 33 ACs carry a pending live journey (qe-report.md:241). <br>• AC-2.1/2.7/2.10, AC-4.5 and the bulk-import non-goal are verified against agent-made wording that the owner has not yet confirmed (SA-1..3). |
| Spec fidelity / no drift | 20 | 4 | 3 | pass | 16.0 | Scope matches the spec. There is no Bexio integration, no Italian data and no edit or delete. The drift record is thorough: D1-D34, G1-G14, UX-1..23 and IM-1..IM-14 (plan.md:1220-1364). IM-13 names every error code that was added, which closes the 20261118 eval's residual (d). Lessons from the 20261118 eval were applied: amendments are tagged, attribution is honest, and the plan approval is recorded as the owner's autonomous-run choice. The constants and signatures I checked match the code: `ACCOUNTING_DEADLINE_MS`, `FX_FETCH_BUDGET_MS`, `CONSUMER_FETCH_BUDGET_MS`, `createAccountingClient`, `referenceSnapshot`. <br>**Not 5:** <br>(a) **An unrequested user-visible limit was not put to the owner.** `CATALOG_CAPS` allows 200 ledger accounts and 50 VAT codes per entity, *deactivated ones included* (`accounting-api/src/catalog/limits.ts:40`, plan.md:1350 IM-6). Entries can never be deleted (AC-1.12), so this is a **lifetime** cap on additions. It narrows AC-1.1 and US-1 ("keep the chart of accounts") for consumers that will add purchase, revenue and depreciation accounts. It is in neither the spec's "Limits" open question (spec.md:527-531, owner accounting), an amendment, AGENTS.md, the READMEs nor the changeset. It was a sound fix for F-01, but nobody who knows the chart's size has seen the number. <br>(b) A stale heading: plan.md:1366 says "Spec amendments proposed (not applied)", but they were applied in `eeb63165` (spec.md:14) and plan.md:1318 says so. <br>(c) ADR `20261119-accounting-reference-data-…` was not touched after implementation (1 commit). Its validation section still says "Planned, not yet run" (:100). It does not record the producer-side size constraint that IM-6 introduces between producer and consumer. <br>(d) SA-1..3 still await the owner. Scoring this dimension 3 would give 72.2, and the verdict would not change. |
| Test quality | 20 | 4 | 3 | pass | 16.0 | The tests are behavioural and adversarial: <br>• real-Postgres integration, and direct-SQL trigger and CHECK tests; <br>• real 20-way concurrency for adds, status changes and exports; <br>• the 20261118 golden CSV is untouched and still byte-equal (qe-report.md:253); <br>• a route x principal matrix that fails on any unlisted route (`matrix.test.ts`); <br>• a cross-package budget test (6 s + margin < 10 s) and a cap cross-package test; <br>• a migration test that carries a 20261118-state DB through both migrations. <br>The mutation sample killed 25 of 29 mutants, and the 4 survivors are argued equivalent (qe-report.md:114-146). The fix round was repro-first: the red test `7d7e435d` (16:06) came before the fix `1a1c86bb` (16:19), and fix mutants were killed (qe-report.md:328, :333). <br>**Against:** <br>(1) The live e2e journeys are written but never executed, including the global-setup seed and release (T51). <br>(2) The dev-built suite tested Refund and Accounting **only against fakes of each other**. The real-client-vs-real-route contract test (`contract.refund-client.test.ts`), the settings-holder denial (`settingsHolder.test.ts`) and the keyboard-only paths (`keyboardOnly.test.tsx`; the plan asked for `userEvent.keyboard`, but the dev suites used `fireEvent.click`) were all **added by QE** (qe-report.md:103-110). <br>(3) The dev suite shipped an order-dependent test (D-5, now fixed). <br>(4) The automated a11y check runs in jsdom only, with contrast off, and a regression in a real browser would not be caught. <br>(5) The security reviews ran no tests. |
| Code quality & conventions | 15 | 4 | 3 | pass | 12.0 | The code is clean and idiomatic, and follows repo conventions: <br>• one narrow port with one typed error, memoised per operation, holding no data (`accountingClient.ts`); <br>• a test seam refused outside `NODE_ENV=test` (`:353`); <br>• integer money (micros and basis points) and tagged-template SQL only; <br>• immutability enforced in the DB, with active state derived from append-only status rows; <br>• RFC 7807 codes, a generic 503 body (`:362-371`) and logs that carry only the kind and the operation; <br>• moves done as `git mv` with history (except IM-4), en/it parity, and changesets present. <br>Fix-round code is small and targeted: key validation before the query, an advisory lock around the cap and duplicate check, header middleware set before and after `next()`, and a quiet Prisma client for the script. <br>**Against:** <br>• **Accepted but open:** F-04 (no attributable security events), F-05 (no plausibility band on fetched rates), F-06 (trigger-only immutability, with the service as table owner). <br>• `seed:welld-ch` bypasses both the cap and the lock (IM-6 info). <br>• Expense-date validation is left as a follow-up (F-02 residual). <br>• The e2e global setup still writes the seed and the release to whatever DB direnv resolves, which by default is the shared dev DB, unless the skip and override variables are set (`shell/e2e/global-setup.ts:29-44`). <br>• Comment blocks are very long, which costs readability, and one of them states false evidence (see Design). |
| Design fidelity (UI) | 15 | 3 | 3 | pass (at floor) | 9.0 | **For:** <br>• design.md was complete for what it designed: flows, the ACs with no UI surface, AS1-AS7 and RS1-RS7 with loading, empty, error, denied, reader and stale states, a component inventory mapped to `@operai/ui`, copy keys and an a11y plan. <br>• QE's static audit finds a named component test for every designed state (qe-report.md:269-283). <br>• Reuse held: only the 5 planned N rows are new in accounting-ui, and `AccountingLinkNote` is the only new component in refund-ui. <br>• About 100 jsdom axe calls report zero violations. <br>**Against:** <br>(a) **No one has seen these screens in a browser.** There has been no contrast, reflow, tab-order, screen-reader or browser axe check of any Accounting screen, and the changed Refund screens were not re-checked either (qe-report.md:32-34, :280). <br>(b) **design.md was never synced after implementation.** Its only commit is `97e89ac2`, and it is still `status: draft` (design.md:3, QE D-8 unresolved). The fix-round states have no design entry: the `catalog_full` 409 message in both add dialogs (T56), and the "empty" refusal for invisible-only names. <br>(c) **`accounting-ui/src/test-support/axe.ts:26-28` still claims contrast "is checked by hand (design.md 'Browser accessibility pass (2026-11-19)' …)"**. That pass was 20261118's, on Refund's screens, and no such section exists in this design.md (QE D-8, left out of the fix round, qe-report.md:335). <br>No design is contradicted, which is why this is not lower. |
| Trajectory | 10 | 3 | 2 | pass | 6.0 | **A trace exists:** `.forge/runs/2026-11-19T10-30-00Z-orchestrate-20261119-accounting.json`. It is **honestly marked** `reconstructed: true`, with a `reconstruction_note`. It was written before the eval from git and hand-back reports (`c1e670e3`, 16:55). It has no per-agent timestamps, and `finished` and `tokens` are null. It is therefore a summary, not a live record. I used it only where git confirms it, and git does confirm it: <br>• the order spec → owner approval → plan → amendments → ADRs → design → plan sync → tasks (with overlap check) → six parallel tracks in isolated worktrees, with no collisions; <br>• QE FAIL → repro-first fix round → QE PASS → security re-review PASS → plan sync. <br>Verification was not skipped. Unlike 20261118, **done-when criteria are honest**: T40-T42 claim static checks only, and the live run is separated into T51 (tasks.md:683-705, :784-791). <br>**Deductions, from the trace and tasks.md:** <br>(1) **env_faults[1]: a devops agent removed `/private/tmp/claude-501/-Users-hermes`, a scratch root possibly used by other sessions.** It was a destructive delete outside the agent's own scratch, and outside the workspace that CLAUDE.md fences. It was reported to the owner, but it happened. <br>(2) The binding `touch:` rule says "added to the task … **before** it is changed". About 20 out-of-list paths were instead reconciled after the fact (tasks.md:1018-1044). <br>(3) The binding "moves keep history" rule was broken for 3 files (IM-4, trace drift_events[1]). <br>(4) The trace is not contemporaneous. Score 4 would give 77.4, and the verdict would not change. |
| **Total** | 115 | | | | **87.0 / 115 = 75.7/100** | |

**Verdict: FAIL.** The total of 75.7 is below `pass_score` 80. **No dimension is below its floor.** AC satisfaction
(4) and design fidelity (3) each sit exactly at their floor. The verdict fails on the total, not on an unmet AC. All 68
ACs have green, executed evidence, and no defect is open against an AC. What is missing is:

- observation of the assembled product and of the screens in a browser (T51, an owner step);
- design upkeep;
- putting one agent-chosen limit to the owner.

## Findings and owners

- **AC satisfaction (4, at floor). Owner: owner step T51, then QE.**
  - Run `cd shell && pnpm e2e accounting refund-` green, with every existing `refund-*.spec.ts`, as T51's done-when
    requires. That includes the axe light/dark and en/it variants of `accounting.spec.ts`.
  - Run the browser contrast and reflow pass on the Accounting screens.
  - Record both in qe-report.md and design.md.
  - Confirm SA-1..SA-3 in T50.

  These steps lift this dimension to 5. **If a journey fails, the failing AC becomes unmet and the eval FAILs on
  the floor as well.**
- **Spec fidelity (4). Owner: plan (architect) for the text; accounting (owner) for the value.**
  - (a) Add the catalog cap to the spec's "Limits" open question as an "owner to confirm" amendment: 200 accounts and
    50 VAT codes, lifetime, deactivated ones included. Also name it in AGENTS.md or `accounting-api/README.md` and in
    the changeset. If accounting expects a larger chart, raise the constant together with the consumer cap or the answer
    shape. The worst case at today's caps is about 127.8 KB against 256 KiB (security-review.md, F-01 closure), so
    the headroom is real but finite.
  - (b) Retitle plan.md:1366, for example "Spec amendments (applied 2026-11-19 in eeb63165, owner to confirm)".
  - (c) Amend ADR `20261119-accounting-reference-data-…`. Change the validation section from planned to done, and
    record the producer-answer-size vs consumer-cap constraint (IM-6).
  - (d) SA-1..3 confirmed at T50.
- **Test quality (4). Owner: QE/dev.**
  - The live e2e, as above.
  - Make the browser axe a regression gate. The e2e axe variants already exist; they need to run in CI or in the
    release checklist.
  - In future, dev tasks should include the producer–consumer contract test that QE had to add here.
- **Code quality (4). Owner: dev/devops, as release decisions at T52.**
  - Decide on F-04, F-05 and F-06 before release.
  - Make `seed:welld-ch` take the cap and the lock (IM-6).
  - Add expense-date validation (the F-02 residual).
  - Reconsider whether the e2e global setup should write to the shared dev DB by default.
- **Design fidelity (3, at floor). Owner: design.**
  - Add an Implementation sync section to design.md, covering the `catalog_full` dialog message, the
    invisible-character "empty" refusal and anything else built since `97e89ac2`.
  - Decide on `status: draft`.
  - Fix the false contrast claim in `accounting-ui/src/test-support/axe.ts:26-28`.
  - The browser pass of T51, recorded in design.md, would lift this to 4.
- **Trajectory (3). Owner: orchestrator (process).**
  - This run's score cannot be recovered after the fact.
  - Future runs must write the trace as they go.
  - Enforce `touch:` before the edit, not at reconciliation.
  - Never let an agent delete outside its own scratch directory: the env_faults[1] incident.

## Path to PASS (arithmetic)

- Today: 87/115 = 75.7.
- **T51 green (live e2e, browser pass) and SA-1..3 confirmed (T50)** → AC satisfaction 5 (+7.0) → 94/115 =
  **81.7, PASS.**
- If the same browser pass is recorded in a synced design.md → design fidelity 4 (+3.0) → 97/115 = **84.3**.
- Documentation alone cannot reach 80:
  - spec fidelity 4 → 5 (items a–c) gives 91/115 = 79.1;
  - a 5 there also needs the owner's SA confirmation.

  **Every route to PASS goes through an owner step**, and T51 is the robust one. Trajectory stays where it is for this
  run.

## Recommended next step

- **FAIL.** T48 stays unchecked, and the spec does not move to `done` (T49 cannot close).
- No product-code rework is required for the eval.
- Owner, in this order:
  1. T51: the live e2e and the browser a11y pass.
  2. T50: accounting confirms SA-1..3 and the limits, **including the catalog cap**.
  3. The architect fixes plan.md:1366 and the reference-data ADR.
  4. Design syncs design.md and fixes the axe.ts comment.
  5. Re-run `/wellforge:eval 20261119-accounting`.

---

# Round 2 (T79, 2026-11-19, HEAD `c4b320f5`)

The front matter now carries the round-2 result. Round 1 above is kept unchanged except for that front matter;
it scored **75.7**, FAIL, at `c1e670e3`. Round 2 scores **the accounting module and the accounting sign-off round as
one deliverable** on `feat/accounting-module`:

- 39 commits in `0b000570..HEAD`, 144 files, +10,593/−4,773;
- the accounting module: the 70 ACs of this spec, i.e. the 68 of round 1 plus AC-2.12 and AC-7.6;
- the sign-off ACs of `specs/20261118-refund-accounting-export`: AC-3.11 to 3.13, 4.11 to 4.13, 6.13 to 6.17, 7.4
  and 8.1 to 8.5, plus the adjusted ACs, with the retired ones checked as retired.

**Rubric:** default-v2, as in round 1. There is still no `gates/configs/eval-rubric.yml` and no `eval.md`. The weights
and floors are unchanged, `pass_score` is 80, and the total is normalised over 115.

## Verification evidence (round 2)

I re-ran every suite below myself at HEAD, read-only, against the isolated Postgres on **127.0.0.1:5446 only**. The
session's env helpers already pointed at `localhost:5446`, and a guard script forced 127.0.0.1:5446 and failed closed
otherwise. I used no other port, no service, no network and no secret. I did not touch or stage `.envrc`, which was
already modified in the tree.

| Suite | My result | Matches QE |
|---|---|---|
| accounting-api `bun test` | 658 pass / 1 skip (the opt-in live AFC test) / 0 fail / 30 files | yes (qe-report.md:351) |
| accounting-api `tsc --noEmit` | clean | yes |
| refund-api `bun test` | 1924 pass / 0 fail / 77 files | yes (qe-report.md:471) |
| refund-api `bun test --randomize --seed 424242` | 1924 pass / 0 fail (D-9 closed) | yes (qe-report.md:473) |
| refund-api `tsc --noEmit` | clean | yes |
| accounting-ui `vitest run` | 564 pass | yes |
| accounting-ui `tsc -b` and `eslint .` | both clean | yes |
| refund-ui `vitest run` | 1331 pass | yes (qe-report.md:358) |
| refund-ui `tsc -b` and `eslint .` | both clean | yes |

**auth:** `git diff 0b000570 HEAD -- auth shell/src operai-ui` is empty, so round 1's auth run still holds (1497 pass,
36 skip, 0 fail). QE's sign-off pass recorded an untracked dotenv file in `auth/` that changes that suite's result
(qe-report.md:388). That is an environment fault, not a defect.

**Other evidence:**

- **QE:** the round's first pass was FAIL with D-9, the same test-order defect class as D-5. Fix round T82 followed,
  and the re-test is PASS (qe-report.md:341-486).
  - The round's mutation sample is 14/14 killed.
  - The N-01 fix carries 5 mutants, all killed.
  - The workbook was compared cell by cell against the accountant's template (structure only). Its only difference,
    D-13, is left to T80.
- **AFC live test:** run once by QE. EUR 0.9246 for 2026-03 from the real endpoint (AC-2.12).
- **Release rehearsal** (`release-rehearsal.md`): the real accounting-api over HTTP with a stand-in auth, on scratch
  databases. It covers exit 3 without the baseline list, exit 2 when Accounting is unreadable, the baseline giving
  N + 1, the dry run, and an idempotent rerun.
- **OWASP sign-off re-review:** PASS, with 0 high or medium findings, 1 low (N-01) and 4 info (security-review.md:114-160).
  **It was static only, and predates the N-01 fix (`e72ac580`).** The fix is covered by QE's tests and mutants, not
  by the security reviewer.
- **Not run by anyone (owner):**
  - T81: the live e2e (239 tests listed, none executed) and the browser a11y pass;
  - the workbook opened in Excel or Numbers;
  - T80: the trial import into Accrio.

## What changed against round 1

| Round-1 finding | Status at HEAD | Evidence |
|---|---|---|
| Spec (a): catalog cap not put to the owner | **Closed** | SA-4 is confirmed by the owner (spec.md, amendment "fix round 1, confirmed by the owner", `b20d5e88`). G16 in design.md records it. |
| Spec (b): stale plan heading | **Closed** | plan.md:1391 now reads "applied in eeb63165 as SA-1 to SA-3, owner to confirm". |
| Spec (c): reference-data ADR stale | **Closed** | `2b7d5453` names the cap test (ADR :104), and `fc31c3d9` adds the sign-off amendment (:126-132). |
| Spec (d): SA-1..3 unconfirmed | **Closed** | They are confirmed by the owner (spec.md:14-17). |
| Design (b): no implementation sync | **Closed for the module, reopened by the round** | `ef805983` (17:11) syncs design.md against `0b000570`, including the `catalog_full` and invisible-character states (§ 3). But the sign-off round started at 20:30 (`1aaa81c0`), and **no design file was touched after it** (see the Design row). |
| Design (c): false contrast claim in `axe.ts` | **Closed** | `ef805983`. |
| Design (a): never seen in a browser | **Open** | design.md § 8 states it plainly; this is owner step T81 (formerly T51). |
| AC / tests: live e2e | **Open** | Owner step (T81). |
| Trajectory: trace and process | **Worse for the round** | See the Trajectory row. |

## Round-2 score table

| Dimension | Weight | Score (/5) | Floor | vs floor | Weighted | Evidence |
|---|---|---|---|---|---|---|
| AC satisfaction | 35 | 4 | 4 | pass (at floor) | 28.0 | **Every live AC of both specs has named, executed, green evidence**, and I reproduced the suites they run in. <br>• The 70 ACs here: qe-report.md:168-239, plus AC-2.12 and AC-7.6 at :426-427. <br>• The 20261118 sign-off ACs: qe-report.md:404-429. <br>• The retired ACs are retired in code, API, UI, seed and docs (qe-report.md:392-398; `removed-routes.test.ts`). <br>I traced the round's AC-critical code myself: <br>• AC-4.11 to 4.13: `baselineSeq` reads the latest row per email over every email of the same `ownerUserId`, takes the maximum, applies to 2026 only, and never moves an existing counter (`numbering.repo.ts:150-166, 262-273`). <br>• AC-6.2 and AC-6.13 to 6.17: `exportFormat.ts` holds the 8 fixed headers, Credit `5832`, CHF, and the `describeLine` pattern with one `sanitizeText` pass (:30-39, :161-164). <br>• AC-2.1 and AC-2.12: the AFC's own "XML-File" is the endpoint already read (plan.md SO-21, `afc.live.test.ts`). <br>**Why not 5:** <br>• The assembled system has still never run. That is T81: the live e2e, the browser pass, and AC-8.4's contrast and real tab order. <br>• **The point of the new export, a file the accounting system imports (20261118 AC-6.2), has not been shown with the real consumer.** No Accrio trial import (T80) has been done, and nobody has opened the workbook in Excel or Numbers. D-13 notes that the template is an Excel *table* and the output is not. <br>• The Description pattern of AC-6.13 is still provisional by the spec's own words. |
| Spec fidelity / no drift | 20 | 4 | 3 | pass | 16.0 | All four round-1 items are closed (table above). The round's amendments are disciplined: <br>• no AC id is reused; <br>• adjusted and retired clauses are marked inline (spec.md:26-78, 20261118 spec amendments E1-E7, F1-F8); <br>• both plans carry a sign-off delta whose AC→test mapping is total over 70 ACs (plan.md:1531-1550); <br>• the AFC channel was **verified, not assumed** (SO-21: the ESTV page links the BAZG endpoint, and the live value matched); <br>• SO-24 scopes what does not change. <br>**Not 5:** <br>(a) **F7 and F8 were added at 23:25 (`8af9e0e7`), after the owner's approval at 20:38 (`1169256f`)**, under an entry that says it "adds no new decision of the owner". F8 changes AC-4.11's behaviour (the baseline follows every address; security N-01). F7 rewrites AC-6.15 to match the code after QE flagged the difference (D-12). Neither is tagged "owner to confirm". This repeats the pattern the 20261118 eval flagged. <br>(b) `refund_line.vatCodeIsDefault` stays as a column written `false`/`null` and read by nothing (QE D-15). That contradicts SO-18's own "one source of truth, no dead columns that look current" reasoning. |
| Test quality | 20 | 4 | 3 | pass | 16.0 | Strong behavioural evidence for the round: <br>• the golden XLSX is compared byte for byte, and its cell list is checked; <br>• `xlsx.test.ts` covers the writer's guards (no formula element, XML-illegal code points refused); <br>• the baseline tests cover case, spaces, multiple emails, another user's email and 2027; <br>• the migration test carries a 20261119130000 database with realistic data; <br>• the release CLI exit codes are tested; <br>• the mutation sample is 14/14, plus 5/5 on the N-01 fix. <br>**Against:** <br>(1) **The dev suite shipped the D-5 defect class a second time** (D-9, a shared scratch DB in `migration.accounting-signoff.test.ts`), one fix round after D-5 was closed. QE caught it, not the dev task. <br>(2) The e2e journeys have been rewritten for the round (`fe98b1ca`) and **never executed**, including the e2e XLSX reader and the global setup's baseline file. <br>(3) No real spreadsheet application or the real importer has read the file. <br>(4) Accessibility is checked in jsdom only. <br>(5) The security reviews ran no tests. |
| Code quality & conventions | 15 | 4 | 3 | pass | 12.0 | The round's code is clean and careful: <br>• a hand-written deterministic OOXML+STORE writer (fixed part names, fixed date, no metadata, a CRC per entry, u32 guards, `quotePrefix` enforced so text never becomes a formula), with the hash it logs being a real fingerprint; <br>• a canonical-number test so that `2620.10` stays text (AC-6.17); <br>• additive migrations only, with no edit of an applied migration; <br>• a strict release-file schema refusing the old shape, distinct exit codes 0/1/2/3, and masked output; <br>• `baselineSeq` scoped by user id. <br>**Against:** <br>• the vestigial `vatCodeIsDefault` column; <br>• N-02 to N-05 (info) and the carried F-04, F-05 and F-06 (low) are open. F-05 now also feeds the workbook's Amount (security-review.md:148). <br>• the seed still bypasses the cap and the lock (IM-6 info); <br>• the Description is sanitised as a whole string rather than per field (fine today; a reason containing `[` reads ambiguously, which is left to T80). |
| Design fidelity (UI) | 15 | **2** | 3 | **FAIL (below floor)** | 6.0 | **For:** <br>• `ef805983` synced design.md with the built Accounting UI: the fix-round states, an honest "not observed" § 8 and a ready checklist for the browser pass. <br>• Every touched refund-ui component has jsdom axe coverage (`ExpenseLineComposer`, `AccountingExportCard`, `LineClassificationPanel`, `ExpenseTypeDefaultsCard`, `DefaultClassificationDialog` tests). <br>**Against (why below the floor):** <br>(a) **The sign-off round rebuilt six Refund screen areas without any design.** These are: the Settings defaults (account only, 14 types), the dialog without VAT, the review panel's optional VAT with "None", the Excel export card and its states, the 14 type labels, and **a new employee-facing split-receipt hint in the expense composer** (`refund-ui/src/strings.ts:280`, `ExpenseLineComposer`). The hint has no entry, copy key row, placement or a11y note in either design file. `specs/20261118-refund-accounting-export/design.md` is untouched since `025dda21`, and this design.md since `ef805983` (17:11), before the round (20:30). <br>(b) **The design now describes retired UI as current.** design.md:261 has "the card of 20261118 S4 (foreign-currency VAT code as one fact with Change and History, then the twelve-row table)", :268 has "Twelve rows", :102 has FR3 "Change a default or the designation", and :271 has the designation warning. The plan was corrected in place for the round ("text above that this delta contradicts has been corrected in place", plan.md:1481-1482), but the design was not. The design→implementation chain is broken for the round: the UI was built from the spec and plan alone. <br>(c) Still no browser observation of any screen in this branch, and design.md is still `status: draft` (deliberate, § Implementation sync). <br>In round 1 this was 3 with "no design is contradicted". It is now contradicted, and new user-facing UI is undesigned. |
| Trajectory | 10 | **2** | 2 | pass (at floor) | 4.0 | **The sign-off round has no run trace at all.** The only trace was closed at `finished: 2026-11-19T18:01:18Z` with `result: "escalated"` (`c47a2180`). Every round commit (`1aaa81c0` 20:30 onwards: T58-T82, QE, OWASP, ADRs, rehearsal) falls after it, and no `.forge/runs/*` file was added. For the round this is the neutral floor. For the module, round 1's reconstructed trace stands. Git shows a sound order: spec amendment → owner approval → plan delta → tasks → tracks → QE FAIL → fix round → QE PASS, with the rehearsal before release. The owner steps are honest (T80, T81). **Deductions, from git and tasks.md:** <br>(1) **`touch:` deviations are undeclared this time.** For example, `fc13501a` (T60) edits T62's `export.repo.ts`, `export.ts`, `export.schemas.ts` and `export.test.ts`. `06837b05` (T62) and `9a81fbec` (T63) edit T60's `natural-keys`, `no-cache` and `accounting-unavailable.matrix` tests. `f7247624`, `ae08a515` and `e6c69167` (T69-T71) edit `strings.ts`/`accountingApi.ts` outside their lists. Round 1 at least reconciled such edits in "Implementation notes"; the round has no such list, although its preamble repeats "a missing path is added here before it is changed" (tasks.md:1062). <br>(2) **T77 is ticked although its done-when says "both reports have verdict PASS for the round"**: `specs/20261118-refund-accounting-export/qe-report.md` has no round section (last commit `566763e1`). The same holds for T78's 20261118 `touch:`. <br>(3) The D-5 defect class was repeated (D-9). <br>(4) Round 1's deductions stand for the module part. |
| **Total** | 115 | | | | **82.0 / 115 = 71.3/100** | |

**Round-2 verdict: FAIL.** There are two reasons:

1. **Design fidelity is 2, below its floor of 3.** A sub-floor dimension fails the eval regardless of the total.
2. The total of 71.3 is below `pass_score` 80.

AC satisfaction sits at its floor and trajectory at its floor. **No AC is unmet, and no defect is open against an AC.**
The drop from 75.7 is in design (3 → 2) and trajectory (3 → 2). Both fell because the sign-off round was run without
updating the design or writing a run record. Spec fidelity holds at 4: round 1's gaps are closed and a new attribution
gap (F7/F8) opened.

## Round-2 findings and owners

- **Design fidelity (2, below floor). Owner: design. This is the blocking item, and needs no owner step.**
  - Add a "Sign-off round sync" to `specs/20261119-accounting/design.md` (and RS/S-deltas in 20261118's design.md, or
    one pointer). It should cover:
    - RS2 and RS3: account only, 14 rows, no designation fact. Mark FR3, :261, :268 and :271 as retired.
    - The review panel's VAT select with "None": set, change, clear, and no VAT amount without a code.
    - The export card as "Download Excel file", with its blockers on accounts only.
    - The split-receipt hint: where it appears (WellD CH lines only), its copy keys en/it, and how it is announced.
    - The type labels.
  - That restores 3. A recorded browser pass (T81) on those states lifts it to 4.
- **AC satisfaction (4, at floor). Owner: owner steps T81 and T80, then QE.**
  - T81: `cd shell && pnpm e2e accounting refund-` green with every `refund-*.spec.ts`, the browser a11y pass, and the
    workbook opened in Excel or Numbers.
  - T80: Accrio imports the golden XLSX without manual fixes, and the Description pattern is confirmed.

  A failing journey or import makes an AC unmet, which is below the floor.
- **Spec fidelity (4). Owner: product owner, then the owner.**
  - Tag F7 and F8 "owner to confirm", or record the owner's confirmation, and correct "adds no new decision of the
    owner".
  - Either drop `vatCodeIsDefault` in a later additive migration or record it as a known vestige in the plan's
    sign-off delta.
- **Test quality (4). Owner: dev/QE.**
  - The live e2e and the real importer, as above.
  - Make "one scratch DB per writing test" a checklist item of any migration-test task, so D-5/D-9 does not return.
- **Code quality (4). Owner: dev, as release decisions at T52.** N-05 (mask the echoed argument), and the carried
  F-04, F-05 and F-06.
- **Trajectory (2, at floor). Owner: orchestrator.**
  - This run cannot be recovered.
  - Untick T77, or add the round's pointer section to `specs/20261118-refund-accounting-export/qe-report.md`.
  - Record the round's `touch:` deviations in tasks.md, as round 1 did.
  - Write a trace for every future run as it happens.

## Path to PASS (arithmetic)

- Today: 82/115 = **71.3**, and design fidelity is below its floor.
- **Design sync for the round alone** (design 2 → 3, +3.0): 85/115 = 73.9. The floor is cleared, but the total is
  not.
- Design sync + **T81 and T80 green**:
  - AC satisfaction 4 → 5 (+7.0) gives 92/115 = **80.0**. That is exactly `pass_score`: PASS with no margin.
  - If T81's browser pass is also recorded in the synced design.md, design goes to 4 (+3.0): 95/115 = **82.6, PASS**.
    **This is the robust route.**
- Spec fidelity 4 → 5 (F7/F8 confirmed, the vestige resolved) adds +4.0 to any of the above.
- Trajectory stays 2 for this run.
- **No route reaches PASS without the design sync, because the floor applies.** No route reaches PASS without the owner
  steps T80 and T81, because of the total.

## Recommended next step (round 2)

- **FAIL.** Leave T79 and T48 unchecked. T49 cannot close, and the spec does not move to `done`.
- In this order:
  1. The designer writes the sign-off round sync (no code change; it clears the floor).
  2. The owner runs T81 (live e2e, browser pass, the workbook in Excel or Numbers) and T80 (the Accrio trial import
     and its answers).
  3. The product owner confirms or tags F7/F8, and the orchestrator handles T77's done-when and the `touch:` record.
  4. Re-run `/wellforge:eval 20261119-accounting`.
- No product-code rework is required for the eval.

---

# Round 3 (T79, 2026-11-20, HEAD `4e7f0642`)

The front matter now carries the round-3 result. Rounds 1 and 2 above are kept unchanged except for that front
matter. Round 2 scored **71.3**, FAIL, with design fidelity below its floor. The scope is the same as round 2: the
accounting module and the sign-off round as one deliverable. The rubric is default-v2, with weights and floors unchanged,
`pass_score` 80, and the total normalised over 115.

**Range:** `2facb68d..HEAD` holds 7 commits, 17 files, +902/−136.

| Commit | Content |
|---|---|
| `6d090e13` | design sync of both design files for the round |
| `aa2e54c8` | the owner confirms F7/F8; out-of-list files recorded |
| `5648da69` | sign-off section in the 20261118 QE report |
| `ebc74dbb`, `ff972e4e`, `0b7e8159` | T83 refund-ui fixes for SG-1 to SG-4 |
| `4e7f0642` | the round's run trace |

The only product code that changed is refund-ui (`ff972e4e`). `git diff 2facb68d HEAD -- accounting-api refund-api
auth accounting-ui shell` is empty, so round 2's re-runs still hold for those packages:

- accounting-api: 658 pass, 1 skip, 0 fail;
- refund-api: 1924 pass, 0 fail, including `--randomize --seed 424242`;
- accounting-ui: 564 pass;
- auth: as in round 1.

**Re-run by me at HEAD (refund-ui):**

- `vitest run`: **1340 pass**, matching the coordinator's figure;
- `tsc -b`, `eslint .` and `vite build`: all clean.

No database was needed. `.envrc` was not touched or staged. The round's trace records that it holds a plaintext
token, which is reported to the owner for rotation.

**T83 has no QE pass.** `5648da69` (09:54) predates `ff972e4e` (09:59). I reviewed T83 myself:

- **SG-1:** one `SplitReceiptHint` sits after the Entity in an always-mounted polite region, and its `aria-describedby`
  is added to both controls only while it is shown (`ExpenseLineComposerHint.tsx`, `ExpenseLineComposerHintIds.ts`).
- **SG-2:** the same component is in the line editor, with a per-line id (`row-<id>-split-hint`), so there are no
  duplicate ids.
- **SG-3:** the title counts only lines the approver can fix, and out-of-scope lines are counted apart
  (`ReviewDetailPage.tsx`).
- **SG-4:** the export card no longer promises a VAT column. It is pinned in en and it by `strings.test.ts`, and the card
  test asserts no "VAT code" with axe.

The changes are small, idiomatic and tested. Re-running refund-ui is the evidence that nothing regressed.

## What changed against round 2

| Round-2 finding | Status at HEAD | Evidence |
|---|---|---|
| Design (a): six Refund areas rebuilt with no design | **Closed** | Both files carry a "Sign-off round sync" (20261118 design.md:731-950; this design.md § Sign-off round sync). It covers: <br>• flows FR1-FR8 and screens RS1-RS7, state by state; <br>• the Excel card, the VAT "None" select, account-only defaults, 14 labels and the split-receipt hint, with placement, copy keys en/it and a11y notes; <br>• UX-24 (Source names the authority first). |
| Design (b): retired UI described as current | **Closed** | Inline "(retired 2026-11-19, sign-off)" and "(changed …)" marks at the former :102, :261, :268 and :271, and at the S6d dialog, the copy-key rows and the S10 wireframes (20261118 design.md:265, :840). The sync states "where this section and the text above disagree, this section describes what is built". |
| Design (c): no browser observation | **Open** | Owner step T81 (design § 8, 20261118 § 5). |
| Spec (a): F7/F8 not owner-confirmed | **Closed** | 20261118 spec: "the owner (Matteo Codogno) confirmed both on 2026-11-20" (`aa2e54c8`). |
| Spec (b): the vestigial `vatCodeIsDefault` | **Withdrawn** | Round 2 was wrong to count it as drift. It is a recorded, reasoned decision: 20261118 plan.md:1320 (SO-2) keeps the column, says how it is written, and says nothing reads it. |
| Trajectory: no trace for the round | **A trace now exists, reconstructed** | `.forge/runs/2026-11-19T20-30-00Z-orchestrate-20261119-accounting-signoff.json`, honestly `reconstructed: true`. See the Trajectory row. |
| Trajectory: `touch:` deviations unrecorded | **Recorded after the fact** | tasks.md "Sign-off round implementation notes (reconciled 2026-11-20)" now lists them, including the T60/T62 cross-edits I found. |
| Trajectory: T77 done-when not met | **Closed** | 20261118 qe-report.md now has a sign-off section with PASS and per-AC evidence (`5648da69`). |

**New, found by the design sync:** SG-4 was a **user-visible defect shipped through two QE PASS verdicts**. The export
card told users the file carries a "VAT code (when the line has one)", which contradicts AC-6.2 and AC-6.14. It was
**pinned by a test asserting the false sentence** (the `AccountingExportCard.test.tsx` line removed in `ff972e4e`). It
is fixed now. It counts below as test-quality and trajectory evidence.

## Round-3 score table

| Dimension | Weight | Score (/5) | Floor | vs floor | Weighted | Evidence |
|---|---|---|---|---|---|---|
| AC satisfaction | 35 | 4 | 4 | pass (at floor) | 28.0 | Unchanged from round 2. Every live AC of both specs has named, executed, green evidence (qe-report.md:168-239 and :404-429; 20261118 qe-report.md § Sign-off round). SG-4's fix removes a UI statement that contradicted AC-6.2 and AC-6.14 (it was copy, not the file). <br>**Why not 5:** the owner steps are still open. <br>• **T81:** the live e2e (never run), the browser pass (AC-8.4 contrast and real tab order), and the workbook opened in Excel or Numbers. <br>• **T80:** the Accrio trial import. This is the consumer the file exists for: 20261118 AC-6.2 says "so the accounting system reads them as such", and D-13 notes the template is an Excel table and the output is not. The Description pattern of AC-6.13 is still provisional by the spec's own words. |
| Spec fidelity / no drift | 20 | 4 | 3 | pass | 16.0 | Every round-1 and round-2 spec item is closed or withdrawn (table above). The amendments, plan deltas (SO-1..SO-24) and ADR amendments are coherent, and F7/F8 now carry the owner's confirmation. <br>**Not 5:** one carried residual remains. 20261118 plan.md:61 still gives `resolveClassification(line, overrides, defaults, foreignVatCodeId)`, and its note "keeps its signature minus the designation" (SO-2, :1320) is not what was built. The code is `resolveClassification(line, defaults, snapshot)` (`refund-api/src/accounting/classification.ts`). This is item (d) of the 20261118 eval, still open. Small, but it is drift in the contract text of the deliverable. |
| Test quality | 20 | 4 | 3 | pass | 16.0 | The round-2 strengths stand: golden XLSX byte for byte, mutation 14/14 plus 5/5 (N-01), the migration test on realistic data, the rehearsal, and real concurrency. T83 adds focused tests: <br>• SG-4 copy pinned in en and it, with a negative assertion; <br>• SG-3 counts; <br>• the hint in the composer and the editor (`ExpenseLineRow.test.tsx`, +85 lines); <br>• axe on the card. <br>**Against:** <br>(1) **The suite encoded SG-4.** A test asserted the false "VAT code (when the line has one)" sentence, and neither QE pass caught that it contradicts AC-6.2. The design sync found it. <br>(2) D-9 repeated the D-5 class, now written down as a rule (tasks.md, round notes). <br>(3) The e2e is still never executed, and no real spreadsheet application or importer has read the file. <br>(4) Accessibility is checked in jsdom only. <br>(5) T83 had no QE pass; the evidence is my refund-ui re-run. |
| Code quality & conventions | 15 | 4 | 3 | pass | 12.0 | As in round 2: a careful deterministic XLSX writer, additive migrations, strict release files, and masked output. T83 is clean: <br>• one shared hint component and one id helper, kept out of the component file so the module exports only a component; <br>• `aria-describedby` merged rather than overwritten; <br>• live region always mounted. <br>**Against:** N-02 to N-05 (info) and the carried F-04, F-05 and F-06 (low) are open. The seed still bypasses the cap and the lock. |
| Design fidelity (UI) | 15 | 3 | 3 | pass (at floor) | 9.0 | **Raised from 2 on new evidence.** Both design files now describe what is built for the round, with retired and changed parts marked inline rather than rewritten. The sync is honest about what it did not see (static read, nothing run). It found four real gaps, one of them a user-facing contradiction of the spec (SG-4), and T83 implemented the proposed answers for all four. <br>**Not 4:** <br>(a) **Still no browser observation of any screen of this branch.** There is no contrast, reflow, real tab order, screen reader or browser axe run (design.md § 8; 20261118 design.md § 5), and the new live region for the hint is exactly the kind of behaviour only a browser can confirm. <br>(b) **The sync predates T83 by ten hours and now describes fixed behaviour as missing.** 20261118 design.md:863-864 says the editor hint is "**Not built**" and the entity switch has "no announcement (SG-1)". The gap table :945-948 lists SG-1..SG-4 as open. For SG-1 it offered three options, and the chosen one (below the grid, a live region, describing both controls) is recorded only in code comments. <br>(c) Both files are still `status: draft` (deliberate, stated). |
| Trajectory | 10 | 2 | 2 | pass (at floor) | 4.0 | **Not raised.** The round's trace now exists. It is honestly marked `reconstructed: true` and was written at the end of the round (`4e7f0642`, 10:00 on 11-20) from git and hand-backs, with no per-agent timestamps. Its content matches git, and it records its own lapses: <br>• drift_events[3]: "design not synced for the round until after eval round 2; SG-4 copy defect found then"; <br>• T58 left refund-api red until T61; <br>• the D-9 repeat. <br>**What I am scoring is what the run did, not the later records of it:** <br>(1) **The designer step was skipped in-run.** The UI was built from the spec and plan, passed QE twice and shipped a spec-contradicting sentence. It was caught only after the eval demanded the sync. <br>(2) `touch:` deviations were again recorded after the fact, here only after the eval named them. The round's own preamble says "before it is changed" (tasks.md:1062). <br>(3) The D-5 defect class was repeated (D-9). <br>(4) T58–T61 were integrated red-then-green, against the move rule "the source package's suite stays green at every commit". <br>(5) T83 was committed with no QE re-test. <br>**For:** <br>• the order spec → owner approval → plan delta → tasks → tracks → QE FAIL → fix → QE PASS → rehearsal is sound; <br>• the owner steps are honest; <br>• T77's done-when is now met. <br>The module's round-1 deductions stand. Records made after an eval are good remediation, but they cannot change the trajectory of the run. |
| **Total** | 115 | | | | **85.0 / 115 = 73.9/100** | |

**Round-3 verdict: FAIL.** The total of 73.9 is below `pass_score` 80. **No dimension is below its floor.** AC
satisfaction, design fidelity and trajectory each sit exactly at their floors. The verdict fails on the total, not on an
unmet AC: every live AC of both specs has executed, green evidence, and no defect is open against an AC. What is
missing is:

- the owner steps that observe the assembled product and the real importer (T80, T81);
- the browser pass;
- one carried contract-text residual.

## Round-3 findings and owners

- **AC satisfaction (4, at floor). Owner: owner steps T81 and T80, then QE.**
  - T81: `cd shell && pnpm e2e accounting refund-` green with every `refund-*.spec.ts`, the browser a11y pass, and the
    workbook opened in Excel or Numbers.
  - T80: Accrio imports the golden XLSX (and one real-batch dry export) without manual fixes, and the Description
    pattern is confirmed.
  - Record both in qe-report.md.

  This lifts the dimension to 5. A failing journey or import makes an AC unmet, which is below the floor, so FAIL.
- **Design fidelity (3, at floor). Owner: design, plus the owner's T81 pass.**
  - Refresh the 20261118 sign-off sync for T83: mark SG-1..SG-4 closed, record the SG-1 option chosen, and correct
    :863-864.
  - Record T81's browser pass, including the hint's live region in a real screen reader, in the "Browser
    accessibility pass" sections.
  - Together these lift the dimension to 4.
- **Spec fidelity (4). Owner: architect.** Correct 20261118 plan.md:61 and SO-2's "keeps its signature" to
  `resolveClassification(line, defaults, snapshot)`, and check the classification ADR's "One function" line against the
  code. This needs no owner step, and lifts the dimension to 5 if nothing new is found.
- **Test quality (4). Owner: QE/dev.**
  - The live e2e and the real importer, as above.
  - Give T83 a QE delta pass.
  - When a copy test pins a sentence that states a fact about a file or an API, check that fact against the AC.
- **Code quality (4). Owner: dev, as release decisions at T52.** N-05, and the carried F-04, F-05 and F-06.
- **Trajectory (2, at floor). Owner: orchestrator.**
  - This run cannot be recovered.
  - In future rounds, run the designer **before** QE whenever a round changes UI.
  - Declare `touch:` additions before the edit.
  - Write traces as the run happens.

## Path to PASS (arithmetic)

- Today: 85/115 = **73.9**.
- **T80 and T81 green** (AC satisfaction 4 → 5, +7.0) gives 92/115 = **80.0**: exactly `pass_score`, a PASS with no
  margin.
- Add the **architect's signature fix** (spec fidelity 4 → 5, +4.0): 96/115 = **83.5**. It needs no owner step and can
  be done now.
- Add **T81's browser pass recorded in a T83-refreshed design sync** (design fidelity 3 → 4, +3.0): 99/115 = **86.1**.
- Without the owner steps, the best reachable total is the signature fix plus the design refresh, at design 3 since a 4
  needs the browser pass: 89/115 = **77.4**. That is not enough, so **PASS needs T80 and T81 green**.
- The robust route is the signature fix now, then T80 and T81 green, then the design refresh.
- Trajectory stays 2 for this run.

## Recommended next step (round 3)

- **FAIL.** Leave T79 and T48 unchecked. T49 cannot close, and the spec does not move to `done`.
- Now, with no owner step needed:
  1. The architect fixes the signature text.
  2. The designer refreshes the 20261118 sync for T83.
  3. QE runs a delta pass on T83.
- Then the owner runs T81 and T80, and records them.
- Re-run `/wellforge:eval 20261119-accounting`.
- No product-code rework is required for the eval.
