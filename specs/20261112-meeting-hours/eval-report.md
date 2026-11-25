---
spec: 20261112
evaluated: 2026-11-25
rubric: default-v2
score: 86.1
verdict: PASS
---
# Eval report: Meeting hours — the hours of a meeting recorded automatically for the people who took part

**This is the second eval pass.** The first, at `fb85544d`, scored PASS 80.0. This pass re-scores every dimension from the evidence at
`48ec8690`. It does not carry the earlier scores over.

**Rubric:** `default-v2`, the tool-bundled copy at `~/.claude/plugins/cache/wellforge/wellforge/2.61.0/config/eval-rubric.yml`. I
resolved it from `installPath` of the `wellforge@wellforge` entry for this project in `~/.claude/plugins/installed_plugins.json`.
`gates/configs/eval-rubric.yml` and `.wellforge-gates/gates/configs/eval-rubric.yml` do not exist. The spec has no `eval.md`, so no
overrides apply. `design.md` exists, so the conditional `design_fidelity` dimension applies and the weight pool is 115.

**What I evaluated:** `feat/meeting-hours` at `48ec8690` (merge base `831bf3fb`). Since the last eval, `git diff fb85544d..HEAD` changes
two code comments (`hours-ui/src/strings/entries.ts:39-43`, `hours-api/src/entries/automatic.test.ts:99`) plus spec A39, plan § Security,
the glossary's **Untouched** and the tasks header. The run trace `.forge/runs/2026-11-24T09-15-00Z-orchestrate-20261112-meeting-hours.json`
was added in `fb85544d`. `qe-report.md` ends at **PASS** (not BLOCKED). `owasp-report.md` is PASS, and its T18 delta is PASS.

**What I re-ran myself.** I edited nothing in the repo. Backend tests used only the `*_test` databases.

| Check | Result | Matches QE |
|---|---|---|
| hours-api `bun run typecheck && bun test` (`DATABASE_URL=…/hours_test`) | 0 errors; **2114 pass, 0 fail**, 51 files | yes |
| meetings-api `bun run typecheck && bun test` (`DATABASE_URL=…/meetings_test`, set explicitly because its preload only defaults it) | exit 0; **2145 pass, 0 fail**, 92 files | yes |
| hours-ui `pnpm lint && pnpm build && pnpm test` | lint 0; build OK; **2794 pass**, 94 files | yes |
| meetings-ui `MeetingPage.test.tsx` | 66 pass | yes |
| `mise run shared:check` / `env:doctor` / `changeset:check` | 35 groups in sync / all checks passed / OK | yes |

**Mutations I ran myself** to see whether the tests fail when the behaviour breaks. They are not QE's M1–M5. Each ran on a throwaway copy
under `/tmp` (since deleted), and the repo was confirmed clean after each one.

| # | Mutation | Tests that went red |
|---|---|---|
| MA | `showsFromMeetingMark` back to the retired rule `origin === 'meeting'` | 18 across 5 files (`fromMeetingMark`, `EntryRow`, `EntriesTable`, `TableView.fromMeeting`, `DeleteEntryDialog`) |
| MB | `DeleteEntryDialog` shows its paragraph by the mark rule instead of `origin` (D70 broken) | exactly the 3 D70 tests |
| MC | `apply()` no longer re-applies an equal `seq` (`<` → `<=`) | 5: AC-4.2 repeats, both A37 day-of-meeting cases, the concurrent first delivery |
| MD | `apply()` without the `FOR UPDATE` row lock | 1: "waits for an apply of the same meeting that is still running" |
| ME | notice router mounted after `jwtMiddleware` (R8) | 12 or more route tests, including "is reached through the assembled app's own order" |
| MG | `apply()` ignores an existing own entry (AC-1.4) | 7, including every AC-1.4 case |
| MH | a half step rounds down (A36) | 3: the 45:00, 1:15:00 and 23:45:00 vectors |
| MI | the sender treats a 404 as permanent (AC-4.2 says retry) | 2: `client.test` "404 is transient", delivery "hours-api not yet deployed" |
| MJ | a change of Operai participants is no longer a hours fact | 3: the `record.test` case and two participants-route cases |

| Dimension | Weight | Score (/5) | Floor | Weighted | Change since last pass | Evidence |
|---|---|---|---|---|---|---|
| AC satisfaction | 35 | 4 | 4 | 28.0 | = (4) | All 28 ACs met, each with an executed test (qe-report § AC sweep, which my suite runs reproduce count for count). The core path is also green end to end on the real dev stack: `meeting-hours.spec.ts` A–C, `meeting-hours-moved.spec.ts` B–E and `meeting-hours-measured.spec.ts` 5/5. A39 now matches the build (spec.md:214-220 vs `entries.routes.ts:372`), and its new claim about the UI is true: `toPatch` sends only changed members (`EntryDialogModel.ts:386-411`) and an empty patch closes without a request (`EntryDialog.tsx:277-283`). Still thin, either test or behaviour but not both: AC-1.6 is proven by structure only (`matrix.test.ts` pins the one `/system/` route; `apply.ts:151` is the only writer of `origin: "meeting"`; crm-api and activities-api are untouched). AC-4.3's Italian is proven in jsdom only. AC-2.2's export clause is inferred from the shared walk (`HoursExport.tsx:44` → `readAllEntries`), with no test of an automatic entry in a workbook. |
| Spec fidelity | 20 | 4 | 3 | 16.0 | = (4) | Contracts as planned: the wire is byte-identical in both services; the route is mounted before the user gate (`hours-api/src/index.ts:67` vs `:76`, pinned by mutation ME); the seven write paths match the plan; the measured-duration commit matches it (`prepareAudio.ts:268-293`); there are two separate rules for mark and paragraph (`EntryRow.tsx:100`, `EntriesTable.tsx:71`, `DeleteEntryDialog.tsx:91`). The withdrawn D74–D76 work is absent. Last pass's doc mismatches are fixed: plan § Security now states `origin` is on the wire (N3), and A39 now agrees with the ADR's rejected Option B (ADR `20261124-a-system-written-…`:51, 76, which predates the code, `b826a48e`). `design.md` `draft` is the plugin default, not drift (`commands/design.md:54-55`). Still present: trivial, documented additions (`on?.type`; the sender-side `invalid_notice`, `delivery.ts:128`, unreachable because meetings-api caps participants at 30, `participants.routes.ts:28`; an adapted header on the `systemAuth` copy, decisions.md:7) and a stale sentence in AGENTS.md:757 (see Findings). |
| Test quality | 20 | 5 | 3 | 20.0 | = (5) | Tests at U, I-H, I-M, C, C-M and E levels on real Postgres, including two-connection races (PATCH vs apply, DELETE vs apply, six versions at once), all-or-nothing under a trigger fault, both sides of the A36 rounding and A42 margin, and the one 401 checked before the body. The tests fail when the behaviour breaks, which my own nine mutations show independently of QE's M1–M5. MA–MJ each turned the tests named for that behaviour red, and no mutation survived. |
| Code quality & conventions | 15 | 5 | 3 | 15.0 | **↑ 4 → 5** | The two stale comments that held it at 4 are fixed and accurate (`strings/entries.ts:40-42`, `automatic.test.ts:99`). A wider search for the retired rule's wording finds none left: the two remaining "the mark stays" are still correct, a hidden meeting at `EntryRow.test.tsx:154` and `world.ts:173` (whose helper only builds entries on a meeting). Idiomatic: `createRoute` with a per-route guard, a strict zod wire as a shared copy, Prisma transactions with raw SQL only as tagged templates, and CHECKs plus a partial unique index in the migration. Error handling is realistic: P2025 maps to 404 or "nothing deleted" (`entries.routes.ts:378`, `:392`); the sender separates transient from permanent outcomes (`client.ts:148-150`), never follows a redirect, times out after 5 s and retries a 401 once (`:127-138`); the delivery uses closed codes and logs no user id. The measured-duration rule is integer-only (`measuredDuration.ts:27-30`). No dependency changed (`git diff 831bf3fb..HEAD` touches no `package.json` or lockfile), and typecheck, lint and build are green. I also checked a person's POST racing `apply()`: the result is the same as "apply, then POST", so no anomaly. |
| Design fidelity (UI) | 15 | 4 | 3 | 12.0 | = (4) | design.md is complete: F1–F5, S1–S5 with variants, every state referenced, an a11y plan with measured contrast (4.99 / 6.29) and four hotspots, and no new component. The build realises S1, S2, S4 and S5. Hotspot 3 (the badge outside the `<p>` lines) is realised, and hotspot 4 (one predicate) is shown by MA flipping both call sites. QE checked keyboard and focus in a real browser (moved spec E). Not done: hotspot 1, the VoiceOver/NVDA listen (design.md:416-417, 457); a fresh measurement of contrast (hotspot 2) and of zoom (design.md:427, "zoom itself not run"); and the G7 browser observation, for which QE used the API timeline and a C-M polling test. |
| Trajectory | 10 | 4 | 2 | 8.0 | **↑ 2 → 4** | A `wellforge-run/v3` trace now exists. The independent hook events in `.forge/runs/.events.jsonl` corroborate it: every `subagent_stop` from 09:39Z to 14:51Z on 2026-11-24 matches the trace's agents in type and order. Git shows every task committed after its `deps:` (for example T4 after T2, T6 after T3/T4/T5, T7 after T6, T11 after T1/T7/T9/T10, T17 and T18 after T15/T16). OWASP ran twice, plan gate 2 was re-approved (`64ad1fce`), and QE ran BLOCKED then PASS, re-run and not waived. It falls short of 5 because the trace was reconstructed after the fact, with an incomplete commit attribution, and the 2026-11-25 round is untraced, with a non-WellForge agent editing code (see Findings). |
| **Total** | **115** | | | **99.0 → 86.1/100** | **was 80.0** | normalised: 99.0 / 115 × 100 |

**Verdict: PASS.** 86.1 against a `pass_score` of 80, and every applicable dimension is at or above its floor. The total now has a 6.1-point
margin, and no single-anchor drop in spec fidelity, code quality, design or trajectory would fail it (the worst, code quality 5→4, gives
83.5). **AC satisfaction still sits exactly on its floor (4/4)**, though: one AC found unmet, or its evidence found weak, would make this a
FAIL whatever the total.

## Findings

### AC satisfaction: 4 (floor 4, met; unchanged)
- **Resolved since last pass:** the A39 wording. The spec (spec.md:214-220) and the glossary now say what the handler does: any saved
  edit stops the entry following its meeting, values not compared, as the ADR decided before the code was written. The new sentence about
  the UI is true. `toPatch` (`hours-ui/src/components/EntryDialogModel.ts:386-411`) builds the body from differing members only, and
  `EntryDialog.tsx:277-283` closes without a request when nothing differs, so only a direct API caller can save an edit that changes
  nothing.
- **Still thin (each "test OR behaviour, not both"):**
  - **AC-1.6** (CRM call and meeting activities record nothing) is shown by structure, which is the right proof for a negative but is
    not observed behaviour.
  - **AC-4.3** (Italian) is shown by `EntryRow.it.test.tsx`, `EntriesTable.it.test.tsx`, `DeleteEntryDialog.it.test.tsx` and
    `catalogGaps` in jsdom; nobody ran a real browser in Italian (qe-report § Not run).
  - **AC-2.2's export clause** has no test with an automatic entry in the workbook. It holds because the export walks the same complete
    list (`HoursExport.tsx:44`) that `TableView.fromMeeting.test.tsx` and `apply.test.ts:763-798` cover, and the workbook has no branch
    on `origin`.
- **To reach 5:** a real-browser pass in Italian (owner: quality-engineer). Optionally, a `hoursWorkbook.test.ts` case with an
  `origin: 'meeting'` entry (owner: frontend-dev).

### Spec fidelity: 4 (unchanged)
- **Resolved since last pass:** plan § Security now says that `origin` is on the wire for every reader and accepts it as no new
  exposure (N3). A39 is settled. `design.md` `status: draft` is the plugin's default when `/wellforge:design` runs without `--gate`
  (`commands/design.md:54-55`), so I no longer count it as drift.
- **Residual documentation drift (no behaviour change):** **AGENTS.md:757** still defines **Untouched** as "any saved change of day,
  duration, note or target". That is the wording A39 was rewritten to replace; spec.md:214-220 and the glossary now say any saved edit,
  values not compared. AGENTS.md:524 ("any saved `PATCH` clears `followsMeeting`") is already right, so the file disagrees with itself.
  Owner: whoever closes T14 (the orchestrator), a one-line edit.
- **Trivial additions, each documented with a reason in decisions.md:**
  - `on?.type` (T16).
  - The sender refusing a body its own wire rejects (`invalid_notice`, `delivery.ts:128`; decisions.md:59). In practice it is
    unreachable: 30 participants at most (`participants.routes.ts:28`) against the wire's 100, and ids at most 64 on both sides.
  - The `systemAuth` copy's adapted header against T2's "byte for byte"; the marked region is identical (decisions.md:7).
- These keep it at 4 ("trivial additions that don't change behaviour") rather than 5 ("zero unrequested scope"). No action needed.

### Design fidelity (UI): 4 (unchanged)
- **The screen-reader listen is still not done** (design hotspot 1, design.md:416-417 and 457): "Meeting, From meeting, Weekly sync"
  read once with VoiceOver and NVDA. Its fix, if it reads badly, is a visually hidden comma. Contrast (4.99 / 6.29) and the 320–375 px
  reflow are the designer's measurements on a fixture; zoom itself was never run.
- **G7** ("the Duration line changes while processing") was not observed in a browser. With the fake AI provider the window is
  about 0.3 s against a 5 s poll, so QE used the API timeline (5/5) and the C-M polling test. The evidence is reasonable, but it is not
  the design's own observation.
- Owner: the quality-engineer for the listen and the re-measurement (it needs a person with VoiceOver/NVDA). G7 needs no action.

### Trajectory: 4 (was 2; the run trace now exists)
- **What lifts it:** the trace (`.forge/runs/2026-11-24T09-15-00Z-orchestrate-20261112-meeting-hours.json`) names every agent, the four
  drift events, the five environment faults and the QE / security / eval verdicts. Independent evidence agrees with it:
  - Hook events: backend-dev ×3 at 09:39–09:41Z (T1–T3), frontend-dev 09:44Z (T10), devops 10:36Z (T12), owasp-reviewer 10:37Z (T13),
    quality-engineer 12:44Z (T11), then designer, architect, product-owner, architect, adr-writer ×2, frontend-dev (T16), backend-dev
    (T15), devops (T17), owasp-reviewer (T18), quality-engineer ×2 and evaluator 14:51Z.
  - Commit times agree with those events.
- **Why not 5:**
  1. **The trace is a reconstruction.** It says `"reconstructed": true`, it was written after the first eval named its absence, it has
     no per-agent timestamps, and `rigor_recorded` and `tokens` are null. Its commit attribution is incomplete: backend-dev's T1–T9 cites
     only `fe4ad008` although nine commits exist (`fe4ad008 e4e09d84 de7bcbc4 1f866176 ae181e29 f2d23b6c 9e39edde 3ab404ea 686c0a39`),
     and T10 (`d5c46eb1`) and T12 (`b1e383f6`) cite none. That is a correct trajectory with evidence gaps, which is anchor 4.
  2. **The 2026-11-25 remediation round is in no trace.** It consists of `48ec8690` plus three `subagent_stop` events at 08:08–08:09Z.
     The two code-comment fixes in it were made by `caveman:cavecrew-builder`, which is not a WellForge agent, rather than the frontend-dev
     and backend-dev the last eval named. The edit is comment-only and correct, so this is not "unauthorized work" in the anchor-1 sense,
     but code edits in this project belong to the WellForge dev agents.
- Owner: the orchestrator. Complete the trace's commit lists, and append the 2026-11-25 round (or record it in a follow-up trace).

### Code quality & conventions: 5 (was 4)
- No finding. What I checked beyond last pass's nits:
  - **Logging style.** The unprefixed, plan-named `meeting_hours.applied` (`apply.ts:167`) is not a divergence: the repo has no single
    log format (bracket prefixes in hours-api, `event:` JSON objects in refund-api, `decide.routes.ts:168`).
  - **A person's POST racing `apply()`.** The POST takes no lock of `apply()`'s, but the outcome is the same as the serial order
    "apply, then POST", so AC-1.4 holds.

### Open items outside the ACs (from the pipeline's own reports; noted, not scored)
- **R9 pre-merge check:** real-recorder sessions of 2 and 15 min, one interrupted and resumed, and 10-minute m4a and webm uploads,
  expecting no `duration_corrected` line. It is the only evidence of whether max(30 s, 10 %) leaves honest recordings alone. It needs a
  person with a microphone. Owner: the owner, **before the merge** (plan § Risks, infra/README § The measured duration).
- **OWASP delta N2:** can a crafted container's timestamps inflate the measured figure? Not checked; the 180-minute bound holds either
  way. Owner: backend-dev, optional.
- **Dev-only hazard behind EF-1:** `bun --hot` stacks job runners in the dev meetings-api. This is pre-existing code, not this feature's.
  Restart the dev stack before reading a red `meeting-hours-measured.spec.ts` as a defect. Owner: backend-dev, outside this spec.
- **Scratch test databases** listed in the trace's env faults (`hours_t2_test` … `hours_t15_test`) are left for the owner to drop.

## Recommended next step
- **PASS.** With no AC to revisit, T14 may proceed and the spec may move to `done` through `/wellforge:done`. Before or at close:
  1. **The owner runs R9's real-recorder check before the merge**, as the plan requires. This is the only item the plan itself makes a
     precondition.
  2. The orchestrator corrects AGENTS.md:757's **Untouched** to match A39 and completes the run trace (commit lists, the 2026-11-25
     round).
  3. Optional, toward 5s: the quality-engineer does the VoiceOver/NVDA listen and a real-browser pass in Italian, and frontend-dev adds a
     workbook test with an automatic entry.
