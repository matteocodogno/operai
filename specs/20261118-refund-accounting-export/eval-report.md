---
spec: 20261118
evaluated: 2026-11-19
rubric: default-v2
score: 73.9
verdict: FAIL
---
# Eval report: Refund accounting — ledger accounts, VAT, receipt numbers and the batch export

**HEAD evaluated:** `19d1f2b5` on `feat/refund-accounting-spec`. The tree is clean and equal to
`origin/feat/refund-accounting-spec`. The diff is `origin/main...HEAD`: 60 commits, 182 files, +34,330/−88.
QE's re-test ran at `6094b486`. Since then only `qe-report.md`, `security-review.md`, `plan.md` and `tasks.md`
have changed (`git diff --stat 6094b486 HEAD`), so the code QE tested is the code evaluated here.

**Rubric.** The repo has no `gates/configs/eval-rubric.yml` and no `.wellforge-gates/`. The synced WellForge
plugin (`~/.claude/plugins/synced/…/wellforge/config/`) ships no rubric file either. This spec has no `eval.md`.
I therefore applied **default-v2**, as every earlier `specs/*/eval-report.md` does (for example
`specs/20261117-legal-entities/eval-report.md`, `specs/20261116-letterhead-service/eval-report.md`):

| Dimension | Weight | Floor |
|---|---|---|
| AC satisfaction | 35 | 4 |
| Spec fidelity | 20 | 3 |
| Test quality | 20 | 3 |
| Code quality | 15 | 3 |
| Design fidelity | 15 | 3 (applies: `design.md` exists) |
| Trajectory | 10 | 2 |

`pass_score` is 80. Design fidelity applies, so the total is normalised over 115.

**Verification evidence.**

I re-ran everything below myself at HEAD, read-only, against the isolated Postgres on :5445 only. I did not use
:5435, any service, the network or any secret.

| Suite | My result | Matches QE re-test |
|---|---|---|
| refund-api `bun test` | 1426 pass / 0 fail / 67 files | yes (qe-report.md:285) |
| refund-api `tsc --noEmit` | clean | yes |
| refund-ui `vitest run` | 1252 pass / 81 files | yes (qe-report.md:288) |
| refund-ui `tsc -b` and `eslint .` | both clean | yes |
| auth `bun test` | 1416 pass / 36 skip / 0 fail | yes (qe-report.md:287) |

Other evidence:

- **QE:** the first pass was FAIL at `e7cf2ad9` with D-1 to D-4. Fix round 1 (T41, T42) followed, and the
  re-test is PASS (qe-report.md:279-309). The re-test includes a 20/20 mutation sample and 4/4 mutants on the fix.
- **OWASP:** the first review was REVIEW REQUIRED (2 medium). The re-review is PASS, with 0 medium and 3 low
  findings left open as accepted (security-review.md:48, :82). **Both reviews were static only.**
- **Not run by anyone:**
  - the live e2e journeys T31 and T32 (tasks.md:538, :554; qe-report.md:57, :294);
  - any real-browser check: no axe, contrast, keyboard order or screen-reader check (qe-report.md:27-30, :224-225).
- **CI:** no run is recorded for this branch.

**Context weighed.** This was an unattended overnight run under the user's pre-authorisation:

- the plan gate was recorded as pre-authorised (plan.md:5);
- the owner had forbidden the shared dev DB and the secrets, so the live e2e step falls to the owner;
- the six open questions were accepted as risk, each with a fallback (spec.md:353-370, plan D1/D2/D3/D5/D10/D13).

I did not count these against the build. For example, I did not treat the seed placeholders `NOVAT` "(to confirm)"
or the provisional CSV dialect as unmet ACs. **Where they leave a behaviour unobserved, I scored it as unverified.
I did not score it as proven.**

| Dimension | Weight | Score (/5) | Floor | Pass vs floor | Weighted | Evidence |
|---|---|---|---|---|---|---|
| AC satisfaction | 35 | 4 | 4 | pass (at floor) | 28.0 | **61/61 ACs have a named, executed, green test** (qe-report.md:137-201), and I reproduced every suite they run in. I traced the AC-critical code myself: <br>• AC-6.3/6.4: `amounts.ts` uses BigInt with one half-up rounding. 1040@924600→962 and 2080@810bp→156. <br>• AC-3.1/3.2/3.4/2.7: `classification.ts:97-133` treats an inactive default or designation as none. A non-CHF line uses only the foreign-currency code. <br>• AC-3.4/4.3/4.10: in `decide.repo.ts` approve, the release gate, the CAS and `classifyAndNumber` share one transaction, and a refusal rolls back. Counters are upserted in ascending year order (`numbering.repo.ts`). <br>• AC-6.1/6.5/6.6/6.7: `export.repo.ts` reads stored classifications only, lists blockers all-or-nothing, and counts IT lines. <br>• AC-6.11: the compile gate is `request:review` (`batches.routes.ts:476`), narrowed to WellD CH. <br>• AC-3.10: the owner key-set test. <br>**Why not 5:** <br>• The assembled system has never run: T31/T32 journeys (14 ACs carry an e2e row), the shell mounting `?section=` tabs, the CSV download through CORS and Blob in a browser, and the e2e global-setup release. <br>• Two readings stay literal-edge: <br>&nbsp;&nbsp;– AC-4.9 in the batch PDF shows compressed runs (`MC26/014–016`), so `MC26/015` is implied, not printed (UX-8); <br>&nbsp;&nbsp;– AC-4.8 skips letterless email parts (IS-7). <br>&nbsp;&nbsp;Both are documented. <br>• ACs A1/A2 were amended post-approval without the owner (see Spec fidelity). Their behaviour is verified, but their wording is not owner-confirmed. |
| Spec fidelity / no drift | 20 | 4 | 3 | pass | 16.0 | No unrequested scope, and implementation drift is recorded unusually thoroughly: IS-1..7 (plan.md:1120-1158), SR-1..10 (:1045-1105), FR-1..5 (:1107-1118), G1-G13/UX-1..14 (:1160-1211), and owner decisions D1-D13 each with a reversal path (:1005-1024). Every code path I traced matches plan text, including the SR-1 line scope (`classification.repo.ts:142`, `:399`) and SR-2 (`:311`; auth `catalogs/refund.ts:149`). Not 5 because of **unrecorded or misleading items**: <br>(a) **Stale Accepted ADR on a security control.** `docs/adr/20261118-accounting-classification-…md` decision 4 still says `reclassify` has `supportedConditions: ["entity"]`. It does not mention SR-2's segregation of duties or the either-grant rule (FR-1), and it documents a `classification_required` refusal for `null` that G8 dropped (no such code exists in refund-api or refund-ui). The ADR was last touched in `8a44b9ac`, before the fix round. Its decision 8 also predates the SR-1 line-level scope. <br>(b) **Misattribution.** plan.md:1028 says the amendments were "Applied by the product owner on 2026-11-18 in commit 6e074318". That commit is agent-authored (Co-Authored-By trailer), 17 min after approval, and the spec itself says "unattended run, user pre-authorised" (spec.md:14). The owner may believe they approved A1/A2 when they did not. <br>(c) The approved spec's ACs (AC-1.2/1.4/1.7/1.8/2.3/3.2/3.4/7.1/7.2) were reworded by agents post-approval. This is disclosed, but nothing marks it "owner to confirm". <br>(d) Minor: the `resolveClassification` signature in plan.md:53 and in the ADR differs from the code. Several 422 codes (`invalid_classification`, `invalid_default`, `invalid_month`, `invalid_request`, `export_log_failed`) are not named in the plan's contracts. If this dimension were scored 3, the total would be 70.4 and the verdict would not change. |
| Test quality | 20 | 4 | 3 | pass | 16.0 | Behavioural and adversarial. <br>• Real-Postgres integration, plus direct-SQL trigger tests: immutability, the paid lock, counter monotonicity, all-or-none receipt columns, and fetched-once. <br>• A byte-for-byte golden CSV (BOM, CRLF, quoting, formula guard). <br>• Real `Promise.all` races over 20 rounds: `approve-accounting.test.ts:491` (AC-4.10), and classification vs approve/mark-paid. <br>• An FX budget test, a failed export-log write that sends no file, and a CLI test of the operator entry point. <br>• Mutation sample 20/20 killed (qe-report.md:98-125), and the fix-round repros were committed red-first (`7bccdde1` before `169d0711`) with 4/4 mutants killed. <br>Against: <br>(1) The e2e journeys (77 + 59 `expect`s) are **written but never executed**, so their correctness is unproven. That includes the global-setup release step, which now runs before every e2e spec (`shell/e2e/global-setup.ts:61`). <br>(2) The suite as first built **encoded the S-01 defect**: a test asserted the whole-request scope (qe-report.md:77). The gap was found only by the static review. <br>(3) AC-4.7 had no lifecycle test until QE added `receipt.lifecycle.test.ts`. <br>(4) No a11y automation (axe) exists, and a11y is asserted only through RTL roles. <br>(5) The security reviews ran no tests. <br>"A few edge cases missing" is anchor 4. |
| Code quality & conventions | 15 | 4 | 3 | pass | 12.0 | Clean and idiomatic, matching the repo's conventions. <br>• Pure modules (`amounts`, `classification`, `receiptNumber`, `export`, `parse`) with integer BigInt money and `RangeError` instead of silent clamping. <br>• One shared resolver behind four call sites, and every CSV dialect choice in `exportFormat.ts` with `FORMAT_VERSION`. <br>• Tagged-template SQL only. The permission is chosen on the `FOR UPDATE`-locked status, and the paid lock is backed by a DB trigger. <br>• RFC 7807 codes and Effect tagged errors (`ClassificationMissingError`). <br>• The outbound fetch is hardened: constant host, `redirect: "error"`, body cap, no XML entity resolution. <br>• Changesets are present, and the en/it strings are at parity. <br>Against: <br>• **Accepted but open:** S-07 (no plausibility band on fetched rates), S-08 (trigger-only immutability, with the service as table owner), S-09 (client-supplied fetch `trigger` label), S-10, and R-1 (a custom role with `reclassify` but no `approve` is not self-restricted). <br>• FR-5/FU-S7: an out-of-scope line refused by `classification_missing` gets no `ErrorSummary` row (plan.md:1118). <br>• The e2e global setup now runs `accounting:release` against whatever DB `direnv` resolves on **every** e2e run, seeding placeholder data unless `E2E_SKIP_REFUND_ACCOUNTING_RELEASE=1` is set (`global-setup.ts:36-61`). This has never been exercised. <br>• Comment blocks are very long, which costs readability in places (for example `numbering.repo.ts:1-41`). |
| Design fidelity (UI) | 15 | 3 | 3 | pass (at floor) | 9.0 | design.md was complete for what it designed: <br>• flows, with the ACs that have no UI surface; <br>• S1-S10 with loading, empty, error, denied, read-only, saving and success states; <br>• a component inventory mapped to `@operai/ui`, copy keys and an a11y plan. <br>QE's static audit names a component test for every designed state, and the 14 N-row components exist (qe-report.md:208-226). The cards reuse `@operai/ui`: `Badge`, `FactList`, `Field`, `DataTable`, `ConfirmDeleteModal`. <br>Against: <br>(a) **Nobody has seen these screens.** No browser run, no shell mount, no axe, no contrast or keyboard-order check (qe-report.md:27-30, :224-225). <br>(b) design.md was **never amended** after the fix round, and is still `status: draft` (design.md:3; QE D-6). Its only commit is `98c3d1f4`. The states built since have no design entry: <br>&nbsp;&nbsp;– the self-restricted read-only panel and its note (`LineClassificationPanel.tsx:124`, `:283`); <br>&nbsp;&nbsp;– the out-of-scope line (`:111`); <br>&nbsp;&nbsp;– the `throttled`/`deferred` month states (T26 follow-up `4a04927d`, `settings.fx.throttled`/`deferred`). <br>(c) The FR-5 gap leaves an undesigned refusal path. <br>No design is contradicted, which is why this is not lower. |
| Trajectory | 10 | 2 | 2 | pass (at floor) | 4.0 | **No `wellforge-run/v1` trace for this feature exists** in `.forge/runs/` of this worktree or of any sibling worktree (the last trace is `2026-11-17T14-58-00Z-orchestrate-20261117-legal-entities.json`). Per the rubric this is the neutral floor. Git shows good habits: <br>• the order spec → plan → amendment → ADRs → design → plan sync → tasks (with overlap check) → implementation; <br>• QE FAIL → repro-first fix round → QE PASS → security re-review; <br>• task-tagged Conventional commits, and fix-round commits within their `touch:` globs. <br>Git also shows deductions that would block a score above 3 even with a trace: <br>• T31 and T32 are ticked `[x]` although their done-when ("`pnpm e2e …` passes") is unmet (tasks.md:537-538, :552-554). <br>• T35 is ticked although its done-when includes `cd shell && pnpm e2e refund-` green (tasks.md:617-619; qe-report.md:31-32 admits it). The status notes are honest, but the checkboxes claim done. <br>• The plan approval and the spec amendments were self-recorded by agents. |
| **Total** | 115 | | | | **85.0 / 115 = 73.9/100** | |

**Verdict: FAIL.** The total of 73.9 is below `pass_score` 80. **No dimension is below its floor.** AC
satisfaction (4), design fidelity (3) and trajectory (2) each sit exactly at their floor. The verdict fails on the
total, not on an unmet AC. All 61 ACs have green, executed evidence. What is missing is observation of the assembled
product, design upkeep and the run record.

## Findings

- **AC satisfaction (4, at floor). Owner: owner step, then QE.** Nothing is unmet, but the system has never run
  end to end. What would raise it to 5:
  - run `cd shell && pnpm e2e refund-accounting` and `refund-accounting-settings` green against the e2e stack
    (`REFUND_FX_SOURCE=off`), together with every existing `refund-*.spec.ts`, as T32's done-when requires;
  - record the result in qe-report.md.

  If a journey fails, the failing AC becomes unmet and the eval FAILs on the floor as well.
- **Spec fidelity (4). Owner: plan (architect), with ADR upkeep.**
  - Amend ADR 20261118-accounting-classification decision 4 for SR-2 and FR-1: `reclassify` declares
    `self-approval`, and the owner is refused if either grant is restricted. Remove the `classification_required` /
    `null` sentence (G8), and add the SR-1 line-level scope to decision 8.
  - Correct plan.md:1028: the amendments were applied by the agent run under pre-authorisation, not by the product
    owner.
  - Mark A1/A2 in spec.md "owner to confirm".
  - Optionally, name the 422/500 codes the routes emit in the plan's contracts.
- **Test quality (4). Owner: QE / dev.** The e2e run above is the main gap. Two smaller gaps:
  - add an automated a11y check (axe in Vitest or in the e2e) for the new cards and panel;
  - add an e2e or integration assertion that the global-setup release step is idempotent against a released DB.
- **Code quality (4). Owner: dev / infra.** These are the accepted security follow-ups FU-S1..S7. Before T40:
  - **S-08 / FU-S3:** a non-owner runtime DB role;
  - **S-07 / FU-S2:** a plausibility band.

  Also reconsider whether every e2e run should seed placeholder accounting data by default.
- **Design fidelity (3, at floor). Owner: design.**
  - Amend design.md with the fix-round states (self-restricted panel, out-of-scope line), the `throttled`/`deferred`
    rate states and the FR-5 refusal row, then move it out of `draft`.
  - A browser pass (keyboard order, contrast, screen reader, axe) on Settings > Accounts and VAT, Settings >
    Exchange rates, the review panel and the export card would lift this to 4.
- **Trajectory (2, at floor). Owner: orchestrator (process).** No run trace was written for the feature. A
  retroactive trace would not be evidence, so this dimension cannot be lifted for this run. Future runs must write
  `.forge/runs/*.json` per the observability skill. Do not tick tasks whose done-when is unmet. Leave T31, T32 and T35
  as `[~]`/pending, or rewrite their done-when explicitly as an owner-confirmed change.

**Path to PASS (arithmetic).** The live e2e green gives AC satisfaction 5 (+7.0). A browser/a11y pass plus the
design.md amendment gives design fidelity 4 (+3.0). With the rest unchanged, that is 95/115 = **82.6**. Trajectory
stays at 2 for this run either way.

## Recommended next step

- **FAIL.** Do not move the spec to `done`. T37 stays unchecked, and T38 cannot close.
- Owner, in this order:
  1. Run the T31/T32 live e2e (the owner step, the shared dev DB). This is the gate that matters most.
  2. Fix the ADR, plan.md:1028 and spec "owner to confirm" items through the architect (no code change).
  3. Amend design.md and run a browser a11y pass through the designer and QE.
  4. Re-run `/wellforge:eval 20261118-refund-accounting-export`.
- No dev rework of product code is required for the eval. The open security follow-ups are release decisions for T39
  and T40, and the evaluator did not change any code.
