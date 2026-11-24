---
spec: 20261112
evaluated: 2026-11-24
rubric: default-v2
score: 80.0
verdict: PASS
---
# Eval report: Meeting hours — the hours of a meeting recorded automatically for the people who took part

**Rubric:** `default-v2`, the tool-bundled copy at
`~/.claude/plugins/cache/wellforge/wellforge/2.61.0/config/eval-rubric.yml`. I resolved it from `installPath` of the `wellforge@wellforge`
entry for this project in `~/.claude/plugins/installed_plugins.json`. Neither `gates/configs/eval-rubric.yml` nor
`.wellforge-gates/gates/configs/eval-rubric.yml` exists. This spec has no `eval.md`, so there are no overrides. `design.md` exists, so the
conditional `design_fidelity` dimension applies and the weight pool is 115.

**What I evaluated:** the code at `d214f614` (`feat/meeting-hours`; merge base `831bf3fb`). `git diff --name-only c3c963b3..HEAD` lists only
`specs/` files, so the code is the code QE's gates measured. `qe-report.md` ends at **PASS** (second pass; EF-1 closed). It is not BLOCKED.

**What I re-ran myself** (read-only, no development database touched):
- hours-ui: `fromMeetingMark`, `DeleteEntryDialog`, `EntryRow`, `EntriesTable` and `TableView.fromMeeting` tests: 97/97 pass.
- meetings-api `measuredDuration.test.ts`: 21/21 pass.
- hours-api `desired.test.ts` and `meetingHoursWire.test.ts`: 75/75 pass (explicit `*_test` `DATABASE_URL`).
- `mise run shared:check`: 35 groups in sync, `meetingHoursWire` and `systemAuth` included.

My counts match QE's.

| Dimension | Weight | Score (/5) | Floor | Weighted | Evidence |
|---|---|---|---|---|---|
| AC satisfaction | 35 | 4 | 4 | 28.0 | All 28 ACs met, each with an executed test (qe-report § AC sweep). The core path also passes end to end on the real dev stack: `meeting-hours.spec.ts` A–C (AC-1.1, 2.1, 2.3, 2.5, 2.7), `meeting-hours-moved.spec.ts` B–E (AC-2.3 as changed, D70), `meeting-hours-measured.spec.ts` 5/5 (AC-3.8, 3.9). AC-1.6 is shown by structure only: `matrix.test.ts` pins the one `/system/` route, and `apply.ts:144-156` is the only writer of `origin: "meeting"`. AC-4.3's Italian is shown only in jsdom (`*.it.test.tsx`, `catalogGaps`), never in a real browser. A39's "saved change" is implemented as "any successful PATCH" (`entries.routes.ts:372`), so a PATCH that resends the stored values stops the entry following its meeting. |
| Spec fidelity | 20 | 4 | 3 | 16.0 | Contracts are as planned. The wire is byte-identical in both services. The route is mounted before the user gate (`hours-api/src/index.ts:67` vs `:76`). The seven write paths match plan § Where meetings-api records a notice. The measured-duration commit matches plan § The measured duration (`prepareAudio.ts:268-293`). The mark predicate and the delete sentence use two separate rules (`EntryRow.tsx:100`, `EntriesTable.tsx:71`, `DeleteEntryDialog.tsx:91`). The withdrawn D74–D76 work is absent: no character-set rule on wire ids, no log line for a refused sub or scope in the guard, no deletion of blocks. Small additions that change no reachable behaviour: `on?.type` (decisions T16), the sender-side `invalid_notice` refusal (`delivery.ts:126-128`), and a shared copy that matches by marked region rather than whole file (only the header comment differs). D71 (backfill A37 limit) is an owner-accepted spec decision, not drift. |
| Test quality | 20 | 5 | 3 | 20.0 | Tests run at U, I-H, I-M, C, C-M and E levels on real Postgres. Races use two connections: `apply.test.ts:556-636` covers the PATCH-vs-apply CAS and DELETE-vs-apply rounds; `:638-684` covers six versions applied at once. All-or-nothing is shown with a trigger fault (`:686-717`). Boundaries are tested on both sides: A36 rounding vectors, the A42 margin at exactly 30 s / 10 % and just past it (`measuredDuration.test.ts:48-79`), the wire at its limits (`notices.routes.test.ts:319`). Every refused credential gets the same 401, checked before the body (`:180-216`). Also covered: 413/415/500, the retry schedule, the disabled channel, and the outbox surviving the cascade. QE mutations M1–M5 each turned the named tests red, and T11's e2e failed under 4 mutations. Real ffmpeg is exercised in `prepare.measured.real.test.ts`. |
| Code quality & conventions | 15 | 4 | 3 | 12.0 | Idiomatic for the repo: Hono `createRoute` with a per-route guard, the strict zod wire as a shared copy, Prisma transactions and raw SQL only as tagged templates, env-doctor and README contract updates, Problem JSON. Error handling is realistic: P2025 maps to 404 (`entries.routes.ts:392`); the sender separates transient from permanent outcomes, uses closed error codes, `redirect: "error"`, a 5 s timeout and one 401 retry (`client.ts:113-154`); no user ids in logs. I found no invented API or dependency, and no `package.json` or lockfile changed. Nits: two comments still state the retired mark rule (Findings). |
| Design fidelity (UI) | 15 | 4 | 3 | 12.0 | design.md is complete: flows F1–F5, screens S1–S5 with variant tables, unchanged loading/empty/error states referenced, an a11y plan with measured contrast (4.99 / 6.29), and a component inventory with "NEW: none". The build matches S1/S2 (cluster wrapper only when marked, badge outside the `<p>` lines, `data-testid`) and S4 (paragraph keyed on `origin` alone). S5 needed no build, and the C-M test pins it. QE checked keyboard and focus in a real browser (moved spec E). Not done: the design's screen-reader listening hotspot (VoiceOver/NVDA), and the G7 "line changes while processing" check in the browser (only an API timeline). `design.md` still says `status: draft`. |
| Trajectory | 10 | 2 | 2 | 4.0 | **No `wellforge-run/v3` run trace exists for this feature** (`grep` of `.forge/runs/*.json` finds none). The rubric therefore requires the neutral floor. Git history `831bf3fb..d214f614` does match the claimed pipeline, and `.forge/runs/.events.jsonl` (hook stops, not attributed to a feature) shows today's agent types in a consistent order. I found no sign of skipped verification. |
| **Total** | **115** | | | **92.0 → 80.0/100** | normalised: 92.0 / 115 × 100 |

**Verdict: PASS.** The score is 80.0 against a `pass_score` of 80, and every applicable dimension is at or above its floor
(AC satisfaction 4/4, trajectory 2/2). **The margin is zero:** one dimension scoring one anchor lower would make this a FAIL. Trajectory
sits at its neutral floor only because no run trace was written. A v3 trace that agrees with the git history would most likely score
4 (→ 83.5).

## Findings

### AC satisfaction: 4 (floor 4, met)
- **AC-1.6 rests on structure, not on observed behaviour.** The claim "CRM call and meeting activities record no automatic entry" is
  proven by three facts. The route matrix (`hours-api/src/matrix.test.ts`) admits only `system:meetings-api`. `apply.ts:144-156` is the
  only place `origin: "meeting"` is written. crm-api and activities-api are unchanged. That is the right proof for a negative AC. It is
  still thinner than the U+I+E evidence the other ACs have.
- **AC-4.3 (Italian) is proven in jsdom only.** `EntryRow.it.test.tsx`, `EntriesTable.it.test.tsx` and `DeleteEntryDialog.it.test.tsx`
  render "Da riunione" and the Italian paragraph, and `catalogGaps` passes. Nobody ran a real browser in Italian (qe-report § Not run).
- **A39's wording vs the build.** A39 says "any saved *change*". The approved plan says "every successful PATCH". The handler sets
  `followsMeeting: false` on any 200 (`entries.routes.ts:372`). So a PATCH sent directly to the API with the stored values unchanged
  makes an untouched entry stop following its meeting (AC-3.1, AC-3.2). The UI cannot send such a PATCH. The effect is the safe one
  (Operai stops writing the entry and never overwrites the person). The ADR rejects comparing values on purpose. QE raised this as an
  observation owned by the spec author.
- **To reach 5:** a real-browser pass in Italian, and A39 reworded to "any saved PATCH" (or the handler changed to match A39's wording),
  so that the spec and the code say the same thing.

### Spec fidelity: 4
- Small additions that change no reachable behaviour:
  - `showsFromMeetingMark` uses `entry.on?.type`; the plan's snippet has `entry.on.type` (decisions T16). The output is the same for
    every typed input.
  - meetings-api refuses to send a body its own wire schema rejects (`invalid_notice`, `delivery.ts:126-128`).
  - hours-api's `systemAuth.middleware.ts` matches meetings-api's in the guard region (lines 23–116 vs 21–114, identical) but differs in
    the header comment. T2 asked for "byte for byte"; the repo's shared-copy check compares marked regions.
- Documentation that no longer matches the build (no behaviour change):
  - plan § Security says `origin` on a moved entry is "shown to its person only". That holds for the UI, not for the JSON a
    `time-entry:read-all` holder receives (owasp-report delta N3).
  - `design.md` still says `status: draft`.
- What is not drift: the backfill's missing A37 re-delivery is ledger **D71**, which the owner accepted, and the D74–D76 withdrawals are
  absent from the code as required.

### Code quality & conventions: 4
- **Two comments still describe the mark rule that AC-2.3 retired** (the code itself follows D67):
  - `hours-ui/src/strings/entries.ts:40-41`: the `fromMeeting` doc says the badge is "kept after the person changes the entry". Under the
    changed AC-2.3, a move to a project, a deal or other work removes it.
  - `hours-api/src/entries/automatic.test.ts:98`: "It remembers its meeting even from the project: **the mark stays**". It is `origin`
    that stays; the mark goes. The assertion on the next line is correct. Only the comment is wrong, and it will mislead the next reader.
- Owner: frontend-dev (strings) and backend-dev (test comment). Comment-only changes. They do not block.

### Design fidelity (UI): 4
- **The a11y hotspot was not verified.** The design asks someone to listen once to "Meeting, From meeting, Weekly sync" with VoiceOver and
  NVDA (design § Accessibility, Hotspots 1). Neither the developers nor QE did it. QE also did not re-measure contrast or the
  320–375 px layout; those figures are still the designer's, taken on a fixture.
- **Design G7 was not observed in a browser.** It says the Duration line updates while the meeting is still processing. With the fake
  AI provider that window is about 0.3 s and the page polls every 5 s, so QE used the API timeline (5/5) and the C-M polling test in
  `MeetingPage.test.tsx` instead. That is reasonable evidence, but it is not the design's own observation.
- **`design.md` status is `draft`.** Housekeeping for `/wellforge:done`.
- Owner: QE for the screen-reader pass; the orchestrator, at close, for the design status.

### Trajectory: 2 (neutral floor; no run trace)
- **There is no feature run trace.** No file in `.forge/runs/` names `20261112-meeting-hours`. Earlier features got one, for example
  `2026-11-19T11-30-00Z-orchestrate-20261116-record-hours-in-place.json`. `.forge/runs/.events.jsonl` has 58 `subagent_stop` events dated
  2026-11-24, with agent types adr-writer, designer, backend-dev, frontend-dev, devops, owasp-reviewer, architect, product-owner and
  quality-engineer. Those events carry no spec, task or verdict, so they are not a trace, and the rubric does not let me score from them.
- **What git history shows**, without lifting the score:
  - The baseline fix `e542e562` comes first, then the spec, plan, design, tasks and ADRs (`b826a48e`).
  - Tasks were committed in dependency order: T2 before T4; T3 before T5; T3, T4 and T5 before T6; T6 before T7; T8 before T9; T1, T7,
    T9 and T10 before T11 and T12.
  - T13 OWASP PASS (`d5102f62`), then the additions (`eb300a81`, 34 ACs), the withdrawals (`20defd53`, 28 ACs), the gate-2 plan approval
    (`64ad1fce`), the tasks re-sync and the ADR amendment (`b787021d`), and the new ADR (`ef89ef43`).
  - T16 (`33822e97`) and T15 (`4bcddbed`) land with no collision. T17 (`117f61bf`) and T18 (`6e5f6714`) follow.
  - QE ran twice: BLOCKED (`d04d80ad`), then PASS (`d214f614`).
  - Nothing was skipped. The BLOCKED QE pass was re-run, not waived.
- **Owner: the orchestrator (`/wellforge:implement`).** It should write the run trace for this feature so trajectory can be scored on
  evidence.

### Open items outside the ACs (from the pipeline's own reports; noted, not scored against)
- **R9 pre-merge check (plan § Risks, infra/README § The measured duration).** Before merging, record with the real recorder for 2 min,
  15 min, and one interrupted-and-resumed session. Upload a 10-minute m4a and a 10-minute webm. Expect no `duration_corrected` line. This
  is the only evidence of whether max(30 s, 10 %) leaves honest recordings alone. It needs a person with a microphone. Owner: the owner,
  before merge.
- **OWASP delta N2.** Can a container with a timestamp jump inflate the measured figure? Not checked. The 180-minute bound holds either
  way. Owner: backend-dev, optional.

## Recommended next step
- **PASS**: T14 may proceed and the spec may move to `done` through `/wellforge:done`, with no AC to revisit. The verdict has no margin,
  so please do the following before or at close (none of them blocks the transition):
  1. The orchestrator writes the feature's `.forge/runs/` trace.
  2. Fix the two stale mark-rule comments: `hours-ui/src/strings/entries.ts:40-41` and `hours-api/src/entries/automatic.test.ts:98`.
  3. The spec author settles A39's wording against `entries.routes.ts:372`.
  4. Set `design.md` to `status: approved` or `done`.
  5. Run R9's real-recorder check before the merge, as the plan requires.
