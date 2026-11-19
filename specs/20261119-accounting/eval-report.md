---
spec: 20261119
evaluated: 2026-11-19
rubric: default-v2
score: 75.7
verdict: FAIL
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
