---
spec: 20261112
evaluated: 2026-11-27
rubric: default-v2
score: 83.5
verdict: PASS
---
# Eval report: Project hours — time worked against what was sold

Previous verdict: PASS 80.0 (US-1–US-4, 30 ACs), committed at `79dd3970`; its findings are input here, not carried as a verdict.

**Rubric:** `default-v2`. Neither `gates/configs/eval-rubric.yml` nor `.wellforge-gates/gates/configs/eval-rubric.yml` exists, so I used the
tool-bundled copy `~/.claude/plugins/cache/wellforge/wellforge/2.61.0/config/eval-rubric.yml` (the `installPath` of `wellforge@wellforge` in
`~/.claude/plugins/installed_plugins.json`; `$CLAUDE_PLUGIN_ROOT` is not set). No `eval.md`, so no overrides. `design.md` exists, so
`design_fidelity` applies and the weight pool is 115.

**What I evaluated:** the whole feature at HEAD `eeab24b7` (`feat/project-hours`), 59 ACs: US-1–US-4 (30) and US-5 (AC-5.1–5.29), with the
amended AC-1.7, AC-1.9 and AC-3.2. Since `79dd3970` the product code changed only in projects-api (`asOf`, 2 files) and projects-ui (US-5,
8 files), plus e2e journeys E and F; hours-api, hours-ui, meetings-api, crm-api, crm-ui and shell source are byte-identical to what the
previous eval scored (`git diff --stat 79dd3970..HEAD -- . ':!specs'`). Spec approved 2026-11-27 after the second re-opening (D86–D94),
plan approved at gate 2 with D95–D96 (eight amendments), design.md amended for US-5 (G7–G13), tasks T1–T19 and T21–T26 checked, T20 open.

**Verification inputs:** `qe-report.md` pass 4 is **PASS** (not BLOCKED): a full sweep of US-5 by a fresh agent, 29/29 ACs executed, the 19
states of design S1.1 rendered (272 captures, en and it, 1280/360/320, both themes), axe 96 runs with 0 violations, every backend and
frontend suite re-run green, e2e 10/10 including E and F. The owasp-reviewer verdicts (US-1–US-4 PASS with one low; US-5 diff PASS, 0
findings at low or above, 2 info) come from the brief; neither report is on disk, but the hook log records the US-5 review
(`.forge/runs/.events.jsonl`, `wellforge:owasp-reviewer`, 14:15Z).

**What I ran myself** (no e2e, no stack, no dev database; the working tree was clean before and after):

| Check | Result |
|---|---|
| projects-ui `pnpm lint`, `tsc -b`, `vitest run` | 0 / 0 / **58 files, 1553 passed + 2 expected-fail** (`MyTasksPage.projectsDown.qe.test.tsx`, predates the feature) |
| projects-ui `vite build` (in a `git archive` copy, so no `dist/` was written to the tree) | built |
| projects-api `typecheck`; `bun test src/terms src/projects src/queue` on the scratch `projects_test` | 0; **546 pass / 0 fail** |
| `mise run shared:check`, `mise run changeset:check` | 36 groups in sync (incl. `timeEntryRecordedEvent`); OK |
| **My mutations of the US-5 product code**, one line each, in a `git archive` copy under the scratchpad | **74 of 74 killed**: 73 in projects-ui (`consumption.ts` 34, `ConsumptionBlock.tsx` 24, `ConsumptionBar.tsx` 9, `HoursSection.tsx` 1, `ProjectDetailPage.tsx` 1, `strings/project.ts` 4) and 1 in projects-api (`asOf` read from a second clock call). **Every mutant was killed by at least one implementer-written test file**, not only by QE's oracle |

| Dimension | Weight | Score (/5) | Floor | Weighted | Evidence |
|---|---|---|---|---|---|
| AC satisfaction | 35 | 4 | 4 | 28.0 | **59 of 59 met as the approved spec states them.** US-1–US-4: product code unchanged since the previous eval, which found all 30 met; QE pass 4 re-ran every suite green (hours-api 2457/0, meetings-api 2169/0, crm-api 2399 + the known red outside scope, hours-ui 3116, crm-ui 1880, shell 766) and re-checked the three amended ACs live (qe-report rows 1.7, 1.9, 3.2). US-5: each AC has unit and component tests, and QE observed each on a live fixture (qe-report pass 4 AC sweep). AC-5.1–5.3: `consumption.ts:318-404`, `consumption.test.ts:361-411`, e2e E (`project-hours.spec.ts:488`, the oracle from the API's own `asOf` and `currentPeriod`). AC-5.4: `shareOf` returns null at a reference ≤ 0 (`:237`), no share for `none`/`not_started`/`unavailable`; `consumption.test.ts:843`, `ConsumptionBlock.signals.test.tsx:616`. AC-5.5–5.9: floor by integer division and states cross-multiplied on exact minutes (`:240-248`); the AC-5.6 property over every minute to 2.5 × the reference (`consumption.test.ts:413-462`); "Limit reached" vs "Over the limit" from `excess === null` (`ConsumptionBlock.tsx:180-190`, `signals.test.tsx:240-284`, it pair in `HoursSection.it.test.tsx`). AC-5.10–5.11: icon per level (`ConsumptionBlock.tsx:173-177`, `:258-261`); bar `aria-hidden` with a closed label set (`ConsumptionBar.tsx:50`, `ConsumptionBar.test.tsx:40-87`). AC-5.12–5.13: `excessOf` half up, `belowOneTenth` (`consumption.ts:208-212`); "Less than 0.1 man-day". AC-5.14–5.17: `bar` positions (`:251-258`), `estimateMarkOf` (`:218-221`); e2e F reads the drawn styles. AC-5.18–5.20: `elapsedPercentOf` (`:197-203`) with the 10-, 365-, 366- and 1-day vectors (`consumption.test.ts:603-668`). AC-5.21–5.24: `dateSignalsOf` reads the terms alone (`:428-440`); dates shown while loading and beside the "unavailable" banner (`ConsumptionBlock.tsx:405-425`). AC-5.25–5.26: `stateSaid` false for `ended` and closed/cancelled (`:327`, `:358`), neutral bar (`ConsumptionBar.tsx:19,47`); e2e F closes the project and reloads. AC-5.27: no function takes a viewer (`consumption.test.ts:1151`), e2e E PM vs reader. AC-5.28: e2e C (`:554`) moves the percentage and not the time elapsed; `signals.test.tsx:1208-1276`. AC-5.29: `asOf` from the one `today` (`terms.ts:233`, `terms.test.ts:937` "reads the clock once"); no `Date` in the module (`consumption.test.ts:1108`), other TZ (`:1132`); QE live in Pacific/Kiritimati and Los Angeles. **Why not 5:** Findings |
| Spec fidelity | 20 | 4 | 3 | 16.0 | The contracts match plan § API contracts. `asOf` is a required string on `TermsSchema` (`projects.schemas.ts:86`), from the same `today` as `currentPeriod` (`terms.ts:225-234`), not in the ETag and refused as input (`terms.test.ts:881`). `consumption.ts` exports exactly the plan's constants, `Share`, `Excess`, `DateSignal`, `consumptionOf(terms, summary, projectState)`, `dateSignalsOf`, `hasConsumptionBlock`, `elapsedPercentOf` and `levelOfState`. `ConsumptionBar({ share })` and the `{ projectId, terms, state }` props are as planned (`ProjectDetailPage.tsx:265`). No route, migration, variable or library export was added. Every reinterpretation is in `decisions.md` § T22–T26: integer civil-date arithmetic instead of `Date.UTC`, thresholds written against the constants, the extra test ids, and F asserting "0.1 man-days". The one design deviation, the narrow-bar rule for the "125%" label (a 17th utility new to the suite), is recorded and folded into design.md and plan.md (`15a85d09`). The previous eval's finding is fixed: the known limitation now names the five cases (a)–(e) in the changeset, AGENTS.md (lines 95-96) and infra/README (`f7bc365d`). **Why not 5:** Findings |
| Test quality | 20 | 5 | 3 | 20.0 | **The tests verify behaviour and would catch regressions.** Of my **74 mutations, all were killed**, each by an implementer-written test. They covered: every boundary (near 30/31 days, today as passed, 80 %/100 % on both sides, exactly 100 % with an excess or a beyond part, the 125 % estimate edge), every rounding (percentage half up, elapsed counting today, span off by one, excess floored), every clamp (within, beyond, elapsed past 100), the no-state rules (ended package; closed and cancelled per variant), the date order and kinds, the 1 March day count, an over-loose date regex, a reversed span, the fallback to a browser clock, the "Limit reached" words, icons per level, the neutral tone, the stripes as shape, `aria-hidden` on the bar and on the percentage, the container-query class, a re-read on a deal event with the project's id, a skeleton on re-read, focus after Retry, the `<time>` element, plurals and the Italian article. QE's own 13 mutations found one survivor in the implementer's suite (the leap rule cut to every fourth year, which matters only for a 29 February in a century year) and one equivalent mutant; QE's committed oracle (`consumption.oracle.qe.test.ts`, 60 000-case Date.UTC and BigInt comparisons) now kills. e2e F was proven to fail when `bg-linear-90` is cut (qe-report pass 4, row "e2e F detects R13"). The projects-api tests pin `asOf` with a clock seam at 23:30Z on the eve of an anniversary, and my second-clock mutant fails two of them. A52 case (e), which the previous eval found unpinned, is now pinned by AC-5.28's tests (`signals.test.tsx:1211`) |
| Code quality & conventions | 15 | 4 | 3 | 12.0 | `consumption.ts` is pure, `import type` only, and uses no `Date`, no float quotient and no clock. It has an exact `intDiv` (`:154`) and a strict civil-date parser that refuses year 0 and impossible days (`:173-188`). A reference ≤ 0 returns no share rather than "NaN %". Thresholds are cross-multiplied on exact minutes. An `asOf` that is absent or malformed means no signal, never a guess. Styling follows the dialect: complete class strings per state (`ConsumptionBar.tsx:14-19`, `ConsumptionBlock.tsx:173-177,258-261`), inline `style` only for positions, every colour a token utility, lint clean. Copy is en/it with formatted figures passed into the sentences (`strings/project.ts` `Count`). There is no new dependency, and every API used exists (Tailwind 4 `@container` / `@max-[…]`, `bg-linear-90`, `bg-size-[…]`, all generated by the shell's 4.3.2 per QE). Lint, `tsc -b` and build are clean. **Why not 5:** Findings |
| Design fidelity (UI) | 15 | 4 | 3 | 12.0 | design.md S1.1 is complete for US-5. It has a 19-row states table per variant (loading, unavailable, re-read, older projects-api, reference 0 included), complete class strings for each tone, a contrast table for both themes, and an a11y plan: the bar `aria-hidden`, the percentage said once, no tab stop, reading order, reflow, greyscale and no motion. The copy is in en/it, the reuse is mapped with one justified NEW component, and the gaps G7–G13 each end with their resolution. The build realises it. QE rendered 19/19 states. Measured contrast matches the design's predictions (lowest 3.02, as predicted). axe found 0 violations in 96 runs, and there are 0 tab stops inside the block. My spot checks of `qe-evidence/signals-fixed-demo-1280-light.png` (identical to the S1.1 sketch: facts, "Over the limit" 112 %, diamond, today mark, stripes, deadline and end-date boxes) and `signals-cap-ended-over-320-light.png` (neutral bar, "Expired", no state words, "125%" dropped) agree. The previous eval's design findings are closed: the six superseded passages are folded, and `status: draft` is now explained as the workflow's convention for an ungated design (design.md line 34). **Why not 5:** Findings |
| Trajectory | 10 | 4 | 2 | 8.0 | A run trace exists for the feature: `2026-11-26T15-13-04Z-orchestrate-20261112-project-hours.json`, `wellforge-run/v3`. It covers US-1–US-4, is written retroactively and says so, and its 25 agent entries agree with the live hook log the previous eval listed. For US-5 the hook log and git give the order. PO (10:31Z, 10:41Z) → spec approved (`66a6d077`, 10:42Z). Then architect 11:03Z → designer 11:29Z → architect 11:42Z. Then adr-writer 13:04Z, PO 13:06Z, architect 13:09Z, designer 13:10Z → gate 2 (`938b36ae`, `4417041b`, 13:11Z) → tasks re-synced (`93166a35`). Then backend-dev T22 (`f5c527df`, 13:20Z) in parallel with frontend-dev T23 (`e0ef9ddb`, 13:31Z) → frontend-dev T24 (`d30ba888`, 13:53Z) → devops T26 (`f7bc365d`, 14:00Z) → plan/design amended for T24's drift (`15a85d09`, 14:09Z) → QE T25 (`663e2192`, 14:11Z) → owasp-reviewer 14:15Z → QE pass 4 (`8aa155c6`, `2c9c41f6`, 14:57Z). The task dependencies held: T24 after T23, and T25 and T26 after T22 and T24. Verification was not skipped: QE did a full sweep with its own mutation check, and the security review ran. **Why not 5:** Findings |
| **Total** | **115** | | | **96.0 → 83.5/100** | normalised: 96.0 / 115 × 100 = **83.48** |

**Verdict: PASS.** 83.5 against a `pass_score` of 80, and every applicable dimension is at or above its floor. AC satisfaction sits on
its floor (4/4). The margin is 3.5 points. Any single one-anchor drop elsewhere still passes: test quality, spec fidelity or trajectory
one lower gives 80.0, 80.0 and 81.7; code or design one lower gives 80.9. AC satisfaction one lower is a FAIL by its floor, as
are any two one-anchor drops on different dimensions (at least 5 weighted points, 91.0 → 79.1).

## Findings

### AC satisfaction: 4 (on its floor)
- **Thin evidence (test, no observed behaviour)**, carried from US-1–US-4 because that code did not change:
  - AC-2.7 (a project awaiting its manager) is integration-only (`people.test.ts:239-270`, the projects-api resolve test). No
    awaiting-manager project was built live.
  - AC-4.11 is unit-only (`tableGrid.test.ts`).

  That is the 4 anchor's "one or two thin". AC-4.10 was observed only through a rewritten response; its backend half is proven by
  integration tests, so I do not count it as a third.
- **US-5 has no thin AC.** The weakest are AC-5.29 and AC-5.6's own example:
  - AC-5.29 was observed with a browser clock and time zone moved to another day, not a real Zurich midnight. That is what the AC asks:
    which day the signals read. It is pinned by tests on both sides.
  - AC-5.6's own example (19 h of 3.0 man-days) is unit-pinned. A live case of the same property was rendered (9 h of 1.1 man-days:
    "Over the limit", 102 %).
- **The A52 judgement is still mine and the reader should see it.** A page left open across a Zurich date keeps its day (A52 (a)–(e)).
  AC-5.28 and AC-5.29 now write case (e) into the criteria themselves ("the time elapsed and the date signals do not change", "kept until
  the page is reloaded"). The code matches them exactly: `asOf` comes only from the project read, and a re-read asks the summary alone.
  For AC-2.8's block in cases (a)–(c) I keep the previous eval's reading: an accepted assumption of the approved spec (D85), not an unmet
  AC. **If a reviewer read A52 as an unmet AC-2.8, this dimension would fall below its floor and the verdict would be FAIL.**
- **To reach 5:** an awaiting-manager journey in e2e (AC-2.7) and an observed table-view check for AC-4.11. Those two only.

### Spec fidelity: 4
- **The T24 deviation was built before it was designed.** The narrow-bar rule (`@max-[230px]:hidden` on the "125%" label) was committed in
  `d30ba888` (13:53Z), and design.md and plan.md were amended after it in `15a85d09` (14:09Z). The plan's eighth amendment came "after
  approval" without a new gate. No AC changes and the label is decoration, so the drift is harmless and recorded. Even so, behaviour went
  ahead of its contract.
- **UI no AC asks for is still present**, listed as droppable by design: the narrow-bar rule, and, from US-1–US-4, the `identities`/`authz`
  notes, the grouping banner and the hints.
- **A stale comment:** `ConsumptionBar.tsx:41-42` says the shell keeps its 64 px rail "at every width". Design's fourth pass corrected that
  to "below 640 px".
- **What would lower it:** an unrecorded contract difference. I found none. I compared `terms.ts`, `projects.schemas.ts`, `consumption.ts`,
  `ConsumptionBar.tsx`, `ConsumptionBlock.tsx`, `HoursSection.tsx` and the page call against plan § API contracts and § Signals.

### Code quality: 4
- **Carried, recorded deferrals:**
  - `ConsumptionBlock.tsx:31` still re-implements hours-ui's `Duration`, against AGENTS.md's "never copy a component from another app".
    It is deliberate, because of the live-shell deploy rule.
  - `DealFilterUnavailable` renders the project refusal too, so its name says less than it does.
  - `summary.ts:133` casts `row.userId as string`.
- **New, small:**
  - `percentOf` (`ConsumptionBlock.tsx:193-196`) and `percentLabel` (`ConsumptionBar.tsx:26-27`) are the same percent formatter call
    written twice.
  - `ConsumptionBlock.tsx` has grown to 471 lines holding seven private components (Group, StateLine, PaceLine, DateLine, Signals, Facts,
    SummaryConsumption). It reads fine, but it is the file a next change will find hardest.
  - The `TODAY_START_BELOW` / `ESTIMATE_*` thresholds were sized for a 234 px bar. QE measured the overhang (≤ 10.3 px, inside the
    padding, G13), so nothing breaks.
- **To reach 5:** lift `Duration` (and the disclosure) into `@operai/ui` once the release order allows it, share one percent helper, and
  rename the refusal component. These are follow-ups, not defects.

### Design fidelity: 4
- **The design's reflow figures were computed, not rendered, and wrong.** It counted a 274/234 px card; the real one is 205/165 px. Only
  T24's render caught it, and the result was an unplanned deviation (the narrow-bar rule) and G13 (labels hang into the padding, measured
  ≤ 10.3 px). The design owned up to it and was corrected, but the US-5 a11y/reflow plan was thin where it mattered most, at 320 px.
- **One a11y item is unrealised at the state US-5 made prominent:** QE O9. At exactly 100 % ("Limit reached") the fact "Hours left 0 min"
  is spoken "0 seconds", and so is "Hours used 0 min". design.md asks for the spoken twin of the short text. The cause is
  `formatDuration(0, { style: 'spoken' })` in `@operai/ui`, so the fix belongs to the library owner, but this feature shows it.
- **Cosmetic items from pass 1 are still open** (QE O4): the period's date range wraps at 1280 when four facts share the row, and the focus
  ring on the Consumption group sits flush against its text.
- **To reach 5:** a spoken zero that says minutes, the O4 items, and a rendered (not computed) reflow check before the next bar-like
  component is designed.

### Trajectory: 4
- **No live trace for either run.** The US-1–US-4 trace was reconstructed after the fact, from git, decisions.md and the QE and eval
  reports. The US-5 trace is to be written after this eval, so for US-5 the evidence is git plus the hook log. Both agree, and the order
  is right.
- **One step ran ahead of its document:** T24's deviation, above.
- **The owasp reports are not on disk.** The US-5 review is evidenced only by the hook event and the brief.
- **To reach 5:** write the US-5 trace from the hook log and these commits before the close, and keep the owasp verdicts in the spec
  directory.

### Test quality: 5
- **Residual gaps.** None reaches the 4 anchor's "edge cases missing".
  - I did not run the e2e (it writes undeletable projects to the shared dev database). E and F are judged from reading
    `project-hours.spec.ts` (E `:488`, C `:554`, F `:698`) and QE's two green runs.
  - F's R13 reads ran against the dev stack's vite shell. A built sheet was checked only by QE's DOM replay, not by a `preview`. The
    deploy-time `curl` of R13 (2) still has to be done at step 3.
  - QE O6 (List and Everyone's hours 409 restart as one chain) still rests on pinned pieces, as before.

## Recommended next step
- **PASS → the spec may move to `done` (T20)**, after the orchestrator writes the US-5 run trace, as the observability skill requires.
- **Not blocking, for the owner:**
  1. QE O9: the spoken zero ("0 seconds") reads wrong at "Limit reached". This is a library change (`formatDuration`), for its owner.
  2. The ConsumptionBar comment at `:41-42`.
  3. The pass-1 cosmetic items (O4).
  4. The open owasp low (projects-ui's block receives `byPerson` on the wire for a project manager and discards it).
  5. The `Duration`/`Disclosure` lift into `@operai/ui`.
  6. R8's way out (re-read the project on a Record hours save), which would end every case of A52.
- **At release:** plan R13 check (2): the live shell's CSS holds `bg-linear-90` before projects-ui (step 5).

**Verdict: PASS — 83.5/100 (default-v2; AC satisfaction on its floor; no dimension below its floor).**

The calls that decide this verdict, made from the evidence cited above and not to land on a number: AC satisfaction at 4 rests on reading
A52 as an accepted assumption of the approved spec (the previous eval's call, which AC-5.28 and AC-5.29 now partly write into the
criteria); test quality at 5 rests on 74/74 mutants of my own plus QE's oracle, with the e2e judged from reading and QE's runs rather than
run by me; trajectory at 4 rests on a retroactive trace corroborated by the live hook log, not on a trace written during either run.
