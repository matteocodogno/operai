---
spec: 20261116
evaluated: 2026-11-19
rubric: default-v2
score: 80.0
verdict: PASS
---
# Eval report: Record hours in place, and a table view of My hours (week and month)

This file holds the latest eval on top and the first eval below it as history, unedited. The front matter belongs to the
latest eval. The first eval's front matter said: `evaluated: 2026-11-19`, `rubric: default-v2`, `score: 82.6`,
`verdict: PASS`.

## Eval 2026-11-19 (2), after the reopening: the table view, week and month

**HEAD evaluated:** `c7f97689` on `feat/record-hours-in-place`. QE pass 5 measured `86a5acb2`. The two commits since then
add only `qe-report.md` and the run trace. The working tree was clean before and after this eval.

**Scope:** `git diff fork/feat/time-tracking..HEAD` (`69b560d3`, an ancestor of HEAD): 94 commits. They touch hours-ui (76
files), projects-ui (23), crm-ui (19), the shell (12), `@operai/ui` (8), changesets, two ADRs, AGENTS.md, `infra/README.md`,
the run traces and the spec folder. No backend file, `package.json` or lockfile changed. The reopening, `9ab6b879..HEAD`,
is weighted most. It touches hours-ui (59 files), `@operai/ui` `DataTable` and `tokens.css`, four `shell/e2e` specs, the ADR,
AGENTS.md, `infra/README.md` and two changesets. It does not touch projects-ui, crm-ui or `shell/src`. A problem in another
module counts as context here, never as a finding.

**Rubric:** `gates/configs/eval-rubric.yml` and `.wellforge-gates/gates/configs/eval-rubric.yml` do not exist. The rubric
used is the plugin's bundled copy,
`/Users/edoardo.paronzini/.claude/plugins/cache/wellforge/wellforge/2.61.0/config/eval-rubric.yml`. That is the
`installPath` of `wellforge@wellforge` 2.61.0, the user-scope install; the 2.57.1 copy is byte-identical. Its version is
**default-v2**: `pass_score` 80; floors AC 4, spec 3, tests 3, code 3, design 3, trajectory 2. There is no `eval.md`.
`design.md` exists, so design fidelity applies and the total is normalised over 115.

**Inputs read:**
- spec.md, re-approved 2026-11-19: 52 ACs, AC-5.12 withdrawn, so **51 in force**: 18 in US-1–US-4 and 33 in US-5.
- ledger.md, all sections, D1–D27.
- plan.md, including § Amendment 2026-11-19 (Decisions 8–15, the address, `TablePeriod`, `tableGrid`, Test strategy,
  R11–R21).
- design.md, including its three amendments of 2026-11-19.
- tasks.md: T1–T26 checked; T27 is the close.
- decisions.md, every section from T17 to the fix round.
- qe-report.md: pass 5 **PASS** on top, pass 4 FAIL below it.
- owasp-report.md: re-check T26, PASS WITH NOTES; L1 fixed in `39ceb3de` and `b3725fb6`.
- The amended ADR `docs/adr/20261116-week-view-sums-a-complete-read-in-the-browser.md` and
  `docs/adr/20261116-record-hours-widget-through-the-host-extension-seam.md`.
- `operai-ui/docs/decisions.md` D-69.
- Both run traces of this feature.
- The production code and tests of the reopening, read in full.

QE did not finish BLOCKED: pass 5 is PASS with 0 defects. The screen-reader readback is out of the gate by D14 and is not
claimed.

**Verification I re-ran at HEAD** (Node 26.10.0 with `NODE_OPTIONS=--no-webstorage`):

| Gate | Result |
|---|---|
| hours-ui unit | **2709/2709** (87 files). No "two children with the same key" warning; the one in the first eval is gone. |
| operai-ui unit | **389/389** (32 files) |
| hours-ui `pnpm lint` / `pnpm build` | exit 0 / exit 0 |
| operai-ui `pnpm lint` / `pnpm typecheck` | exit 0 / exit 0 |
| Plan R3 on the built hours-ui `dist/` | `exceljs` appears only in `hoursWorkbook-*.js` |
| `mise run changeset:check` | OK. `hours-ui-record-in-place.md` and `operai-ui-datatable-pin.md` are among the matched. |
| `mise run shared:check` | 33 groups in sync |

**Not re-run:** e2e, and the projects-ui, crm-ui and shell unit suites. e2e needs the dev stack and leaves companies, deals and
projects in the dev databases. The reopening changed none of those three apps' code. For them I rely on QE's runs:
- pass 5 at `86a5acb2`: e2e **31/31** across `hours-in-place.spec.ts`, `.round1`, `hours.spec.ts` and
  `hours-owners.spec.ts`; projects-ui 941 passed + 2 expected fail; crm-ui 1824/1824;
- pass 4 at `1ff16599`: shell 706/706, `ui:check` exit 0, `react:skew` and `env:doctor` OK.

Production code has not changed since pass 5.

| Dimension | Weight | Score (/5) | Floor | Weighted | Evidence |
|---|---|---|---|---|---|
| AC satisfaction | 35 | 4 | 4 | 28.0 | All 51 ACs are met, with passing tests at HEAD; QE pass 4 executed 51/51 and pass 5 carried them with e2e 31/31. Two ACs have thin evidence in the month: AC-5.7 and AC-5.23 (and the unreadable half of AC-5.24) are tested but have never been observed in the month (Findings). |
| Spec fidelity | 20 | 4 | 3 | 16.0 | The address, `TablePeriod`, `tableGrid`, the period's read, the width, the copy keys and `pin` follow the plan. The first eval's drift items are now in the plan and design. A few small, documented items are not (Findings). |
| Test quality | 20 | 4 | 3 | 16.0 | Boundary-day and D25/D26 vectors, hostile addresses, abort and failure paths, real-stack e2e G.1–G.8, and mutants killed in passes 4 and 5. Some planned month vectors are missing, only Chromium was run, and a defect class went untested until QE pass 4 (Findings). |
| Code quality | 15 | 4 | 3 | 12.0 | Pure period arithmetic, readers that never pass an unchecked value, abort and stale-drop handling, and a sound `pin` with no re-render. No invented API. Nits: the page's size and setState during render, three day validators, dead `clamp`, stale comments (Findings). |
| Design fidelity (UI) | 15 | 4 | 3 | 12.0 | The design amendment decides every open item and covers states, focus, tab order and ARIA. QE saw it built, live. Not 5: D14, QE O1 and O2, and the long-name rule, which the design never covered (Findings). |
| Trajectory | 10 | 4 | 2 | 8.0 | The reopened run's trace lists every agent in order, with commits that exist in git; QE ran twice and OWASP once. The first half of the feature (T1–T15, QE passes 1–2) has no trace (Findings). |
| **Total** | 115 | | | **92 / 115 = 80.0/100** | |

**Verdict: PASS, with no margin.** The total is 80.0 and `pass_score` is 80; the rule is total ≥ `pass_score`. No applicable
dimension is below its floor: AC satisfaction is 4 with a floor of 4, and every other dimension is 4 against a floor of 3,
or 2 for trajectory.

**The verdict rests on every 4 holding.** Any one dimension one anchor lower would FAIL. The smallest such drop, trajectory
to 3, gives 90/115 = 78.3; code quality to 3 gives 89/115 = 77.4. On the other side, AC satisfaction at 5 would give 86.1,
and trajectory at 5 would give 81.7.

**Why the total is lower than the first eval's 82.6.**
- AC satisfaction drops from 5 to 4. The first eval gave 5 on live observations carried from QE pass 1 at an earlier base,
  and called that choice "open to challenge". QE pass 4 now lists AC-5.7 and AC-5.23 as unit-only, and the month has never
  been observed for them. The rubric's lower-anchor rule applies.
- Trajectory rises from 2 to 4, because a trace now exists.

### Findings

**AC satisfaction (4): every AC is met; the month half of two is thin.**

*Met, with test and behaviour:*
- **US-1 to US-4:** e2e A–E and R1–R4. Their only production change in the reopening is the D1 wrap classes (`7e7397e5`),
  which pass 5 re-measured: 98/98 placement checks.
- **US-5:** e2e F and G.1–G.8 at 31/31, plus pass 4's live drives x1–x10. For example:
  - AC-5.25–5.28: G.2, with mutant M3 killed;
  - AC-5.29: G.1, M7 killed;
  - AC-5.30 and 5.31: G.3, M1 killed by the hardened step;
  - AC-5.32: G.2, M4 killed;
  - AC-5.33: G.4 at 1440 and 1920 px, M5 killed;
  - AC-5.34: G.5 and G.7, M6 killed.
- **AC-5.21 and 5.22:** `MyHoursPage.month.test.tsx:469-567`, and pass 4 live x4 through week → month → List → table.

*Thin (test only in the month):*
- **AC-5.7.** The fold's tests (`hours-ui/src/lib/tableGrid.test.ts:125-162`) use the week's days. The fold takes any list of
  days (`:506-526`), so the month is covered only by inference. Not driven live in passes 4–5 ("needs a deal-linked meeting").
  The only live drive is pass 1's, on the Week at `4e659056`.
- **AC-5.23.** The component cases run in both periods (`TableView.test.tsx:102`, `describe.each(CASES)`), but it is not
  driven live in either period since pass 1.
- **AC-5.24, unreadable half.** Unit only. The retired half was driven in both periods (pass 4 x6).

*What would raise it to 5:* at HEAD, a live drive or an e2e step in the month for (1) a row the person cannot read, using
someone who lost `projects:access`, and (2) a meeting linked to a deal, whose hours stay on the meeting's row.

**Spec fidelity (4): contracts as planned; a few small items recorded only in decisions.md.**

*What matches the plan:*
- The address: `readMyHoursAddress`, `withTablePeriod`, `withList` and `withTable` at
  `hours-ui/src/components/HoursFiltersState.ts:117,133,158,170`.
- The future clamps: `hours-ui/src/lib/week.ts:80` and `hours-ui/src/lib/month.ts:96-100`.
- The `TablePeriod` contract, with D25 and D26 in `switchTo` (`hours-ui/src/lib/tablePeriod.ts:124`).
- The read: `whose: 'mine'` over the period's first and last day only (`hours-ui/src/pages/MyHoursPage.tsx:193,204-207`),
  folded inside the read (`:86-89`).
- Empty cells are not controls (`hours-ui/src/components/TableView.tsx:141`).
- `wide` on every route (`hours-ui/src/components/HoursShell.tsx:35`).
- `pin` per D27 (`operai-ui/src/components/DataTable.tsx:92-131`).
- The ADR amended in place, as R3 says.
- The first eval's items (a)–(e) are now written in: `ListRows`, the `cacheKey`s, `useHoursQuery`, `DeleteEntryDialog` and
  the `locked` alias in plan.md's Components table (`plan.md:50,72-76`); S3, S4 and the `status` in design.md
  § "design text brought in line".

*Not 5: small, documented items, none of which changes a contract.*
- **(a) `pickedPeriod`** was added beyond the plan's `TablePeriod` contract (`tablePeriod.ts:172`, decisions T23).
- **(b) `clamp`** is exported and unit-tested but has no production caller (decisions T20 and T22). AC-5.29 is enforced by the
  two readers instead.
- **(c) The long-name rules** are written only in decisions.md. Neither the plan nor the design was amended for them:
  - the row label's `max-w-64 break-words` (`TableView.tsx:127`, the owasp L1 fix). It also changes the week, where names
    longer than about 36 characters now wrap where there is room;
  - the D1 wraps in the shared `EntryRow`, `DeleteEntryDialog`, `EntryDialog`, `RecordHours` and `TableCellDialog`
    (`7e7397e5`), which also change the List.
- **(d) The pin surface** is `--ink` for a table on the page and `--ink-soft` in a card (D-69). The design names only
  `--ink-soft`. The month sits in a card, so it shows `--ink-soft`.
- **(e) Corrected the same day:** `withList` after the month keeps `week` (D26). plan.md was fixed in `bf47e492`.

*What would raise it to 5:* write the long-name rule and `pickedPeriod` into plan.md and design.md, and either use `clamp`
or remove it.

**Test quality (4): deep, and shown to fail when the code is broken; a few planned or cross-browser cases missing.**

*Strengths:*
- `hours-ui/src/lib/tablePeriod.test.ts`:
  - boundary days (Sunday 1 November 2026; the week Mon 30 Nov – Sun 6 Dec);
  - every D25 and D26 vector, including the round trip (`:395-507`);
  - `pickedPeriod` against digit-by-digit years, 30 February and five-digit years (`:550-632`).
- `HoursFiltersState.address.test.ts` covers every row of the address table and hostile values.
- `MyHoursPage.month.test.tsx`:
  - a deal-filter 503 replaces the grid (`:636`);
  - a failed page means no partial grid (`:658`);
  - a late answer is dropped on a switch (`:678`);
  - filters survive every switch (`:469-567`).
- `TableView.test.tsx:244-345`: an empty cell has no tab stop, no `data-cell`, and a click does nothing.
- `operai-ui/src/components/DataTable.test.tsx`:
  - markup without `pin` is unchanged (`:17`);
  - measurement and cleanup (`:91`);
  - a structural test that the sticky rules sit only in the 48 rem block (`:196`).
- e2e G.1–G.8 run on the real stack, computing expected periods with the same rules (R21).
- Mutants: pass 4 killed 6 of 7 by e2e, and M1 by 12 unit tests; pass 5 killed G.8's 6 of 6, and M1 again with the
  hardened G.3.

*Not 5:*
- **(a) Planned month vectors are missing.** The plan's Test strategy rows ("AC-5.25" and "AC-5.3, 5.6–5.11 … in the month")
  ask for `tableGrid.test.ts` vectors over a 30- and a 31-day month, with entries on the 1st and the last day and one on the
  next month's 1st that throws. They were not written, and no decision records that. The component month fixture reuses the
  week's seven dates (decisions T22). The month's ends are checked only by e2e G.2 and G.6.
- **(b) A whole defect class went untested until QE pass 4.** Long unbreakable names (D1, and L1 before it) passed every test
  written for T2, T12 and T24. G.8 guards them now, at e2e level only, since jsdom has no layout.
- **(c) Only Chromium was run.** R16's typing contract for the native date input, and the pinned cells with collapsed borders
  and focus scrolling, are unproven in Firefox and WebKit (D-69, QE).
- **(d) Some "nothing happens" assertions follow fixed waits:** `waitForTimeout(300–500)` at
  `shell/e2e/hours-in-place.spec.ts:682,1359,1400,1471`. Killed mutants M1, M2 and M4 show these steps can fail.
- **(e) The first eval's weak tests are unchanged:**
  - `projects-ui/src/components/ProjectTaskItem.recordHours.list.test.tsx` cannot fail through the code;
  - the 1.5 s grace at `hours-in-place.spec.ts:164`.
- **(f) Coverage is not measured.**

*What would raise it to 5:* the month vectors of (a), and a Firefox and WebKit run of G.3 and G.5.

**Code quality (4): clean and conventional; nits.**

*Strengths:*
- Day arithmetic is pure, in UTC on the date alone. A caller bug is a `TypeError`.
- The address readers never pass an unchecked value into a request; owasp's probe of about 50 hostile values found no
  violation.
- A walk is aborted on a key change, and a late answer is dropped.
- An entry outside the period is a failed read with Retry, not a crash (`MyHoursPage.tsx:78-89`).
- The date field is uncontrolled for a stated reason, R16 (`PeriodDateField.tsx:58,71`).
- `pin` writes measured widths as element styles with no re-render, uses a `ResizeObserver` with a fallback, cleans up, and
  leaves the markup unchanged without a pin (`DataTable.tsx:92-131`). Its CSS sits in one media block (`tokens.css:1537-1591`).
- Lint and build are clean, and R3 holds.
- No invented API: `wrap-anywhere` exists from Tailwind 4.1, the repo pins `^4.2.2` and the class is in the built CSS;
  `RadioGroupField`, `DateInput` and `Field` are existing library exports.

*Nits:*
- **(a) `MyHoursPage.tsx` is now 766 lines,** with three setState-during-render sites (`:321`, `:415`, `:420-425`). The
  reopening added `askTableFocus(null)` in render (T20). Plan decision 15 accepted this, with the extraction as a follow-up.
- **(b) Three implementations of "is this a real calendar day":**
  - `week.ts:19` `dayOf`;
  - `month.ts:29` `isDay`;
  - `tablePeriod.ts:157` `isCalendarDay`.

  `month.ts`'s header explains why it does not import `week.ts`: an import cycle. But `week.ts` imports only `period.ts`, so
  that import would make no cycle. This is the "two copies of one rule" shape the suite's ADRs warn about.
- **(c) `clamp` is dead in production.**
- **(d) Comments still say "week" for code that now draws a month:** `TableView.tsx:36,48` and `TableCellDialog.tsx:34-35`.
- **(e) The first eval's nits are unchanged:**
  - the six-prop seam contract is copied by hand in five places, with no `shared:check` group;
  - crm-ui and projects-ui cache the seam import differently (`crm-ui/src/components/RecordHoursAction.tsx:22` against
    `projects-ui/src/components/RecordHoursAction.tsx:76`);
  - focus workarounds reach into the library's DOM (`TableView.tsx:336`, `TableCellDialog.tsx:54`).

*What would raise it to 5:*
- one day validator;
- the table's read, re-read and focus machinery extracted from `MyHoursPage`;
- a `shared:check` group for the seam contract.

**Design fidelity (4): complete, and built as designed; a few items thin.**

*Complete:* § Amendment 2026-11-19 has:
- the 14 decided items;
- flows F3, F5′, F6 and F7;
- a states table: loading, empty, filtered, error, replaced, after a write, source down;
- focus rules, tab order, ARIA and contrast;
- a reuse inventory: 14 library components and 5 formatters reused, 2 app-level pieces, 1 optional library prop;
- en and it copy.

*Realised:* QE pass 4 saw each of these live:
- the toolbar under the heading;
- the compact month header with a hidden long date;
- blank empty cells;
- Next and the return `aria-disabled`;
- pins from 768 px, opaque in both themes;
- the month's hint at every width;
- the scroll position kept across a re-read (G18);
- focus going to the heading when a cell empties;
- the Tab order, read live in both periods;
- the Italian copy;
- one width over 8 window configurations × 5 pages.

*Not 5:*
- **(a) D14:** the screen-reader readback is out of the gate, by the user's decision.
- **(b) QE O1:** the week's hint is `lg:hidden` (`TableView.tsx:270-273`), so it is keyed to the window, not to whether the
  table overflows. With the shell's rail open at 1024–1100 px, the week scrolls 32–108 px with no hint. This is a design gap.
- **(c) QE O2 (R-D1):** a filled cell reads as plain text at rest. This is an accepted risk.
- **(d) The design never covered names with no break opportunity.** owasp found L1 and QE pass 4 found D1, both downstream.
  Both are fixed in code, but design.md does not state the rule.
- **(e) The pins are unverified in Firefox and Safari** (D-69).

*What would raise it to 5:* amend design.md for the long-name rule, key the week's hint to overflow, and run the readback.

**Trajectory (4): the reopened run is fully traced; the first half is not.**

*The reopened run* (`.forge/runs/2026-11-19T11-30-00Z-orchestrate-20261116-record-hours-in-place.json`) lists, in order:
1. architect `0324d699`, adr-writer `b18343b3`, designer `b420dcf4`;
2. T17–T23 by frontend-dev: `a799d441`, `d3310a58`, `2f04146a`, `8f57b5e9`, `a36b3d14`, `03146b53`, `51302166`;
3. T24 by QE (`06f2721a`), T25 by devops (`32d05c87`), T26 by owasp (`baf60340`);
4. the L1 fixes, `39ceb3de` and `b3725fb6`;
5. QE pass 4 FAIL (`687204b8`), the fix round (`7e7397e5`), QE pass 5 PASS (`1c72af5f`).

Every commit exists in git in that order. The approval gates also ran in order: the spec was re-approved (`34d3902f`) before
the plan (`0324d699`, re-approved `36e66536`), then the design (`b420dcf4`, re-approved `60cd6237`), then the tasks
(`b1d85618`). The reopening itself was the user's sanctioned path (D22: revert `9ab6b879` of the close `29c97359`). Four drift
events are recorded, each resolved, by D22, D25, D26 or the plan correction `bf47e492`.

*Not 5:*
- **(a) The first half has no trace.** T1–T15, QE passes 1–2, fix round 1 and the first OWASP review ran without one; the
  first trace (`2026-11-19T07-40-00Z…`) says so. Their order is inferable from git, decisions.md (each task names its agent)
  and the reports.
- **(b) The fix-round cap is spent: 2 of 2.** The owasp L1 fixes were not counted as a round; the trace states this openly.
- **(c) The revert's subject is not a Conventional Commit:** `Revert "docs(specs): spec status done" — …` (AGENTS.md § Git).
  A squash merge would remove it.

### Recommended next step

- **PASS → T27 may proceed:** `/wellforge:done 20261116-record-hours-in-place`. The main loop should finish the reopened run's
  trace: set `verdicts.eval` to PASS with score 80.0, and fill `finished` and `result`.
- **The PASS has no margin, so the cheapest way to add some is AC evidence.** A live drive at HEAD, in the month, of an
  unreadable row (AC-5.23 and the unreadable half of AC-5.24) and of a meeting linked to a deal (AC-5.7) would justify AC
  satisfaction 5 (86.1). Owner: QE.
- **Follow-ups (not part of the gate):**
  - The `tableGrid` month vectors the plan asked for. Owner: frontend-dev.
  - Write the long-name rule and `pickedPeriod` into plan.md and design.md; remove or use `clamp`. Owner: architect,
    designer.
  - QE O1 (key the week's hint to overflow) and O2. Owner: designer.
  - One day validator, and the extraction from `MyHoursPage` (plan decision 15). Owner: frontend-dev.
  - A Firefox and WebKit run of G.3 and G.5. Owner: QE, once the browsers are installed.
  - The screen-reader readback (D14). Owner: a person with NVDA and VoiceOver.
  - Still open from the first eval:
    - a `shared:check` group for the seam contract;
    - one caching style in the two `RecordHoursAction`s;
    - the import-once test in projects-ui.

---

# History — the first eval (2026-11-19, before the reopening; PASS 82.6), kept unedited

# Eval report: Record hours in place, and a Week view of My hours

**HEAD evaluated:** `52262f64` on `feat/record-hours-in-place`, stacked on `feat/time-tracking` (`69b560d3`, an ancestor of
HEAD). QE pass 3 measured `c4b4f0cd`. The only change since then is `52262f64`, which adds 129 lines to `qe-report.md`.

**Scope:** what this branch adds on top of `feat/time-tracking`, read with `git diff --name-only feat/time-tracking...HEAD`.
That is 53 commits and 131 files. They change hours-ui, the shell, projects-ui and crm-ui, plus one bug fix in `@operai/ui`
`ListRows`, two ADRs, AGENTS.md, `infra/README.md`, changesets and the spec folder. No backend file, `package.json` or
lockfile changes. A problem in another module counts as context here, never as a finding.

**Rubric:** the bundled copy of the WellForge plugin. `gates/configs/eval-rubric.yml` and
`.wellforge-gates/gates/configs/eval-rubric.yml` do not exist, so the rubric is
`~/.claude/plugins/cache/wellforge/wellforge/2.61.0/config/eval-rubric.yml`, the `installPath` of
`wellforge@wellforge` 2.61.0. Its version is **default-v2**: `pass_score` 80, floors AC 4, spec 3, tests 3, code 3,
design 3 and trajectory 2. There is no `eval.md`. `design.md` exists, so design fidelity applies and the total is
normalised over 115.

**Inputs read:** spec.md (41 ACs, amended for D12 and D13), plan.md (first amendment G1–G7), design.md (F1–F6, S1–S9,
§ Gaps, § Amendment 2026-11-19), tasks.md (T1–T15 checked, T16 the close), decisions.md, ledger.md (D1–D14) and
qe-report.md. The latest QE pass is pass 3, 2026-11-19, **PASS**: 0 defects, nothing blocked, and the screen-reader
readback excluded by D14 and not claimed. owasp-report.md is **PASS**: N1 fixed, 0 findings at medium or above.

**Verification I re-ran at HEAD** (Node 26.10.0 with `NODE_OPTIONS=--no-webstorage`):

| Gate | Result |
|---|---|
| hours-ui unit | **2153/2153** (81 files) |
| projects-ui unit | **941 passed + 2 expected fail** (45 files; the two `it.fails` are in `MyTasksPage.projectsDown.qe.test.tsx`, outside the diff) |
| crm-ui unit | **1824/1824** (94 files) |
| shell unit | **706/706** (43 files) |
| operai-ui `ListRows.test.tsx` | **9/9** |
| `pnpm lint` | exit 0 in all four apps |
| `pnpm build` (`tsc -b` + vite) | exit 0 in all four apps |
| Plan R3 on the built hours-ui `dist/` | `exceljs` appears only in `hoursWorkbook-*.js`, which only `App-*.js` names; `RecordHours-*.js` imports only the shared scope, `EntryDialog-*.js` and `shell/session` |
| `mise run changeset:check` | OK. The feature's four changesets and `operai-ui-list-rows-keyed.md` are matched |

**Not re-run:** e2e. It needs the dev stack, and it leaves companies, deals and projects in the dev databases. I rely on
QE pass 3's fresh run at `c4b4f0cd`, where the production code is the same as at HEAD:
- `hours-in-place.spec.ts` and `hours-in-place.round1.spec.ts`: 10/10, with notify-api up;
- `hours.spec.ts` and `hours-owners.spec.ts`: 12/12.

**Context, not a finding:** the hours-ui run prints one React duplicate-key warning. It comes from
`src/components/EntriesTable.test.tsx`, a time-tracking test outside this diff, whose fixture renders two entries with id
`e1` through `DataTable`, which this branch does not change. It contradicts QE pass 3's line "0 'same key' warnings in
any of the ten suite outputs". That is a wording slip in the QE report, not a defect of this feature.

| Dimension | Weight | Score (/5) | Floor | Weighted | Evidence |
|---|---|---|---|---|---|
| AC satisfaction | 35 | 5 | 4 | 35.0 | All 41 ACs are met. Each is backed by a passing test at HEAD and by observed behaviour; the details follow the table. |
| Spec fidelity | 20 | 4 | 3 | 16.0 | Every planned contract is implemented as written. A few documented changes outside the plan alter existing behaviour (Findings). |
| Test quality | 20 | 4 | 3 | 16.0 | The tests check each AC and the error and edge cases, and QE showed by mutation that they catch regressions. A few tests are weak (Findings). |
| Code quality | 15 | 4 | 3 | 12.0 | Conventional, with real error handling and no invented APIs. Minor nits (Findings). |
| Design fidelity (UI) | 15 | 4 | 3 | 12.0 | design.md is complete and the build follows it. Not 5 because of D14 and some stale design text (Findings). |
| Trajectory | 10 | 2 | 2 | 4.0 | No run trace exists for this feature, so this is the rubric's neutral floor (Findings). |
| **Total** | 115 | | | **95 / 115 = 82.6/100** | |

**Verdict: PASS.** The total is 82.6 against a `pass_score` of 80, so the margin is 2.6. No applicable dimension is below
its floor. AC satisfaction is 5 (floor 4), trajectory is 2, exactly at its floor of 2, and the rest are 4 (floor 3).

**The margin rests on the AC score.** If AC satisfaction were 4, the total would be 88/115 = 76.5 and the verdict
FAIL. The neutral trajectory score takes 6 points off the achievable maximum. The rationale for 5 is below.

## AC evidence

**ACs with a test and an end-to-end journey:**

| AC | Journey | What the journey checks |
|---|---|---|
| AC-1.1–1.3 | e2e A | button shown to a team member; project as text, Day today, Duration focused; a reader gets no button and no fallback |
| AC-2.1–2.3, 3.1, 3.3 | e2e B | the owner sees it in the header; the assignee of the deal's task sees none there but one on the row; the entry carries `activity.id` |
| AC-3.2 | e2e C | |
| AC-3.4, 3.5 | e2e D | category required; the saved entry is other work and contains neither the company id nor the task id |
| AC-4.1, 4.3 | e2e A | My hours lists the same values; facts and tasks text unchanged; no host read after the save |
| AC-4.2 | R1, R2 | |
| AC-4.5 | e2e E | the hours `remoteEntry.js` is aborted |
| AC-5.1–5.6, 5.8–5.10, 5.12–5.17, 5.19, 5.20 | e2e F | exact cell, row and day totals; `['3 h','1 h 30','5 h','—','1 h','—','—','10 h 30']` |

**ACs with a test and a live drive:**

| AC | Test | Live drive |
|---|---|---|
| AC-4.4 | `RecordHours.test.tsx` "what it never does" | QE pass 2 |
| AC-4.6 | parity and hardcoded-copy tests in four apps; `RecordHours.it.test.tsx` and `WeekView.it.test.tsx` | QE pass 2, Italian |
| AC-5.11 | `WeekView.test.tsx`, 42 h and 1 h weeks | a 160 h week, QE pass 2 |
| AC-3.6, 5.7, 5.18, 5.21–5.24 | unit and component tests, green at HEAD | QE pass 1 (`4e659056`), at an earlier base |

For the last row, QE pass 3 checked that the production patch is unchanged since then. Pass 1's evidence is specific:
- AC-5.23: a person who lost `projects:access` sees rows labelled "Not visible to you".
- AC-5.24: the retired-category row has no plus on its empty cells and no Add hours, while Edit and Delete stay.

**Why 5:** every AC has a passing test and observed behaviour, which is anchor 5. The rubric's lower-anchor rule was
weighed against the one weakness: for those eight ACs the live observation was made at an earlier base and carried over,
not repeated. The verdict depends on this choice, and it is open to challenge.

## Findings

**Spec fidelity (4).**

*What matches the plan:*
- The six-prop extension type is at `shell/src/lib/extensions.tsx:45`, with the loader at `:68` and the expose at
  `hours-ui/vite.config.ts:44`.
- `checkProps` and `presetOf` implement the plan's valid sets (`hours-ui/src/RecordHoursModel.ts:44`, `:76`).
- The "who" rules are pure functions, as decision 3 says: `projects-ui/src/lib/recordHours.ts:30,85` and
  `crm-ui/src/lib/recordHours.ts:21,47`. They match hours-api's owners: crm-api's resolve
  `involved = [ownerUserId, technical]`, `crm-api/src/activity-host/resolve.routes.ts:160`.
- The Week reads one complete week with `whose: 'mine'` and the week's span (`hours-ui/src/pages/MyHoursPage.tsx:90-93`,
  `:194-207`). The address is `?view=week&week=`, and no backend changed.

*Not 5: changes outside the plan.* Each is recorded in decisions.md and serves AC-4.3 and G1 (the message must survive
the host list's re-reads), but they change behaviour of existing screens, and the plan's Components table was never
amended for them. decisions.md's own header says such drift should amend the plan.
- **(a)** `@operai/ui` `ListRows` now keys a row by its child's key, a behaviour change for every caller, shipped through
  the shell. design.md § Component inventory says "0 NEW or EXTENDED library components".
- **(b)** `cacheKey` on projects-ui `TasksCard.tsx:83` and crm-ui `ActivityTimeline.tsx:46`. On those cards, a revisit
  now shows the last-known rows and refreshes behind them.
- **(c)** The `useHoursQuery` stale-outcome fix and the `DeleteEntryDialog` focus fix.
- **(d)** `ActivityField` keeps a deprecated `locked` alias instead of the plan's rename.
- **(e)** The widget opens the dialog only after the lists answer, as the plan says. Design S4 says it opens at once;
  design.md was not amended.

**Test quality (4).**

*Strengths:*
- `RecordHours.test.tsx` covers every refusal, the aborted reads, focus return, message persistence and "never
  PATCH or DELETE".
- `weekGrid.test.ts` checks the invariants (Σ cells = row, Σ rows = week = Σ days, each entry in exactly one cell) over
  a mixed set.
- `MyHoursPage.week.test.tsx:855-930` walks two pages and checks that a failed second page draws no grid.
- e2e A–F use the real stack with exact figures; R1–R4 are real-browser regressions.
- QE killed 7 of 7 mutants in pass 2, and in pass 3 the reader mutants of `bbe8747c` were also killed.

*Not 5:*
- **(a)** `projects-ui/src/components/ProjectTaskItem.recordHours.list.test.tsx`: "100 rows import `shell/extensions`
  once" cannot fail because of the code, since the module system caches the import (the file's header says so). Its
  two tests are order-dependent.
- **(b)** Some "not offered" assertions rest on fixed waits: 25 ms in `ProjectDetailPage.recordHours.test.tsx:72-74`
  and the 1.5 s grace of `recordHoursSettled`, `shell/e2e/hours-in-place.spec.ts:131`. Positive controls and the QE
  mutants mitigate this.
- **(c)** The focus-after-refusal unit tests depend on an emulation, `hours-ui/src/test-support/focusFixup.ts`. Only e2e
  R1–R3 prove the real browser's behaviour.
- **(d)** Coverage is not measured; no gate is configured in these apps.
- **(e)** ACs 3.6, 5.7, 5.18 and 5.21–5.24 are tested only at unit or component level.

**Code quality (4).**

*Strengths:*
- Authority stays with hours-api, which fails closed. The host rules decide only whether a button shows.
- `checkProps` throws with messages that hold no value, so the host's boundary shows its fallback.
- Reads nobody waits for any more are aborted (`hours-ui/src/RecordHours.tsx:58-64`, `:89`).
- `weekGrid` is pure and throws on an entry outside the week; the page turns that into a failed read with Retry
  (`MyHoursPage.tsx:90-93`).
- R3 holds in the build. Lint and build are clean.

*Nits:*
- **(a)** Two near-identical `RecordHoursAction` wrappers cache the seam import differently: crm-ui at module scope
  (`crm-ui/src/components/RecordHoursAction.tsx:18-22`), projects-ui once per instance
  (`projects-ui/src/components/RecordHoursAction.tsx:76`).
- **(b)** The six-prop contract is copied by hand in five places: the shell's `extensions.tsx` and `remotes.d.ts`,
  crm-ui's and projects-ui's `remotes.d.ts`, and hours-ui's `RecordHoursModel.ts`. No `shared:check` group covers them;
  only the runtime `checkProps` would catch a mismatch.
- **(c)** The focus workarounds reach into the library's DOM: `closest('form')…button[type="submit"]` at
  `EntryDialog.tsx:261` and `DeleteEntryDialog.tsx:52`, and `heading.tabIndex = -1` at `WeekCellDialog.tsx:64`.
- **(d)** `MyHoursPage.tsx` is now 761 lines, with state updates during render and a numbered focus-request machine. The
  tests pass, but it costs maintenance.
- **(e)** crm-ui's `recordHoursPropsOf` does not guard a blank deal id, which projects-ui does. This is safe: the widget
  throws and the fallback link shows.

**Design fidelity (4).**

*Complete:* design.md has flows F1–F6, states S1–S9 (loading, empty, filtered-empty, not started, error, replaced) and a
full a11y plan (keyboard, focus, ARIA, contrast, table rather than ARIA grid). It maps reuse to `@operai/ui` with zero new
library components, and has en and it copy.

*Realised:* QE measured it:
- the layout at 375, 960 and 1024 px;
- the scroll hint, shown below `lg` only and `aria-hidden`;
- the region label;
- focus after every write, refusal and retry.

*Not 5:*
- **(a)** By D14 (the user's decision), the a11y plan's spoken announcements are not verified by a screen reader.
  Pass 3 says so and does not claim them.
- **(b)** S4 promises "the dialog opens at once" with Loading hints inside it (`design.md:295`). The build shows a busy
  button instead, and the design was not amended.
- **(c)** S3 still says a second save "restarts its timer" (`design.md:204`), although G1 removed the timer.
- **(d)** design.md's front matter still says `status: draft`.
- **(e)** "Fits at 960" is a few pixels optimistic (QE).

*Context, not counted:* the 375 px figures assume the shell's rail is collapsed. That is a shell issue, outside scope.

**Trajectory (2).** `.forge/runs/` has no trace for this feature; the newest is
`2026-11-18T14-00-00Z-orchestrate-20261112-time-tracking.json`. The rubric then gives the neutral floor, whatever git
shows. Git history is consistent with a correct trajectory:
1. plan and ADRs (`3b3793fe`, `4d2233dc`);
2. design, with the user's D12 and D13 (`506f664e`);
3. tasks (`09afa559`);
4. T1–T12, with decisions recorded per task;
5. e2e (T13), OWASP PASS (T14), docs and changesets (T15);
6. QE FAIL (`4e659056`), then a fix round (`1871838d` … `ea592129`);
7. OWASP follow-up PASS (`239a6302`);
8. QE pass 2 BLOCKED only on the readback (`04467c43`);
9. the user's D14 (`c4b4f0cd`);
10. the rebase and a test-only fix (`8ffd408c`, `bbe8747c`);
11. QE pass 3 PASS (`52262f64`).

Two points to note:
- `c38326b9` committed a deliberately failing test (QE D1), made green in `1871838d`.
- D14 took a gate row out by the user's explicit decision, recorded in the ledger and design.md. It was not skipped
  silently.

A faithful trace would very likely score 4.

## Recommended next step

- **PASS → the spec may move to `done`.** T16 (`/wellforge:done 20261116-record-hours-in-place`) can proceed. The main
  loop should write this feature's run trace (owner: orchestrator); it is the one item that would lift trajectory.
- **Follow-ups (not part of the gate):**
  - The screen-reader readback (D14; the script is in qe-report.md pass 2 § Blocked). Owner: a person with NVDA and
    VoiceOver.
  - Tidy design.md: S3's timer sentence, S4's "opens at once", and `status`. Owner: designer.
  - Add a plan note for the `ListRows`, `cacheKey`, `useHoursQuery` and `DeleteEntryDialog` changes outside the plan.
    Owner: architect.
  - Add a `shared:check` group or a type-level check for the six-prop contract, and make the two `RecordHoursAction`
    wrappers cache the seam import the same way. Owner: frontend-dev.
