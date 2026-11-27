---
spec: 20261112
evaluated: 2026-11-27
rubric: default-v2
score: 80.0
verdict: PASS
---
# Eval report: Project hours — time worked against what was sold

**Rubric:** `default-v2`. Neither `gates/configs/eval-rubric.yml` nor `.wellforge-gates/gates/configs/eval-rubric.yml` exists, so I used the
tool-bundled copy at `~/.claude/plugins/cache/wellforge/wellforge/2.61.0/config/eval-rubric.yml`. I found it through the `installPath` of the
`wellforge@wellforge` entry in `~/.claude/plugins/installed_plugins.json` (`$CLAUDE_PLUGIN_ROOT` is not set). The spec has no `eval.md`, so no
overrides apply. `design.md` exists, so the conditional `design_fidelity` dimension applies and the weight pool is 115.

**What I evaluated:** HEAD `fb82ddae` on `feat/project-hours`, range `a61939cd..HEAD`. That is 44 commits and 231 files, +16,433/−456; 146 of
those files are outside `specs/`, `docs/` and `*.md`. Spec approved 2026-11-26 and amended for D81–D85 (A52). Plan approved, six amendments.
Design: D80 plus the QE D1/D3 amendments. Tasks T1–T19 and T21 are checked; T20 is the close.

**Verification inputs:** `qe-report.md` ends at **PASS** (pass 3, measured at `2166b8e7`), not BLOCKED. QE's diff checks show no product code
has changed since pass 1, so pass 1's backend runs stand: hours-api 2457/0, meetings-api 2169/0, projects-api 1260/0, crm-api 2399 with one
known red outside the feature. Pass 1 also ran 8/8 e2e journeys against real owners and measured coverage on the changed files at 96.7–100 %.
The owasp-reviewer verdict (PASS: 0 critical, high or medium; 1 low; 4 info) comes from the brief. It is not on disk.

**What I ran myself** (no backend test, e2e, browser or stack, as instructed; the tree was clean before and after):

| Check | Result |
|---|---|
| hours-ui `pnpm lint`, `tsc -b`, `vitest run` | 0 / 0 / **104 files, 3116 passed** |
| projects-ui `pnpm lint`, `tsc -b`, `vitest run` | 0 / 0 / **55 files, 1169 passed + 2 expected-fail** (`MyTasksPage.projectsDown.qe.test.tsx`, which predates this feature) |
| crm-ui `pnpm lint`, `tsc -b`, `vitest run` with `NODE_OPTIONS=--no-webstorage` (as QE ran it) | 0 / 0 / **100 files, 1880 passed** |
| crm-ui without the flag | 1 red, `src/hooks/useOfferDraft.test.tsx` (web storage). This feature does not touch the file (`git diff --stat a61939cd..HEAD -- crm-ui/src/hooks/` is empty). Pre-existing, not counted |
| shell `pnpm lint`, `tsc -b`, `tsc -p tsconfig.e2e.json`, `vitest run` (`--no-webstorage`) | 0 / 0 / 0 / **46 files, 766 passed** |
| `mise run shared:check` | 36 groups in sync, including `timeEntryRecordedEvent` |
| `mise run changeset:check` | OK (`.changeset/project-hours-card-and-consumption.md`) |
| **My own mutations**: 31 single-line changes to product code, run in a `git archive` copy under the scratchpad (deleted afterwards), each against its own test files | **31/31 killed** (Test quality below) |

| Dimension | Weight | Score (/5) | Floor | Weighted | Evidence |
|---|---|---|---|---|---|
| AC satisfaction | 35 | 4 | 4 | 28.0 | **All 30 ACs are met as the approved spec states them, A52 included.** Each has an executed test and most have observed behaviour. **US-1:** AC-1.1–1.3 and 1.9: `packagePeriod` (`projects-api/src/terms/packagePeriod.ts:68-87`) is proven by `packagePeriod.test.ts` and by the QE oracle `packagePeriod.oracle.test.ts`, which kills 3 mutations. `currentPeriod` appears on every `TermsViewSchema` answer (`terms.ts:166-216`, `terms.test.ts`). The summary window is checked in `hours-api/src/summary/figures.test.ts:144-205`. e2e `project-hours.spec.ts:234` A shows used and left in period 2, and the "Expired" badge is in the screenshot `qe-evidence/variant-capexp-320-dark.png`. AC-1.4–1.6: `consumption.ts:62-63` (half up in integers) and `:154-179`, with the vectors in `consumption.test.ts:52-125`; live 7.5 / 10.0 / 12.0 man-days. AC-1.7: `HoursSection.tsx:43` and `consumption.test.ts:235`. AC-1.8: the key-set test `answer.test.ts:73` and the money scan `HoursSection.test.tsx:471`. **US-2:** AC-2.1 and 2.2: `summary.ts:151-166`, `figures.test.ts:43`, `:255`, `HostHours.test.tsx:163-256`, e2e B. AC-2.3–2.5: `summary.ts:107-115`, `people.test.ts:64-238`, e2e B (PM against reader). AC-2.6 and 4.9: `record.test.ts:139-240`; four failure combinations in `HoursSection.test.tsx:286-363`; live screenshot `unavailable-both-1280-light.png`. AC-2.7: `people.test.ts:239-270` and the projects-api resolve (`activity-host.routes.ts:63,131`). AC-2.8: `RecordHours.tsx:119-120`, `HostHours.tsx:77-87`, `ConsumptionBlock.tsx:158-165`, e2e C. **US-3:** AC-3.1: `matrix.test.ts` (one new GET, write routes pinned). AC-3.2: `catalogGaps` and the copy scans pass in 3 apps. **US-4:** AC-4.1–4.5 and 4.10: `filters.ts:109-135`, `list.routes.ts:192`, `totals.ts:66-98`, `labels/resolve.ts:206,247,273`, `projectFilter.test.ts:60-240`, `totals/projectMeetings.test.ts`, e2e D and visibility C (relink). AC-4.6: `hoursWorkbook.ts:196,213`, `hoursWorkbook.test.ts:76,253`, and the file sum equals the totals in visibility C. AC-4.7: `meetingLinkOf` returns an id only when visible; outsider check in visibility C. AC-4.8: `MyHoursPage.tsx:258-268`, `HoursExport.tsx:47` (T21). AC-4.11: `tableGrid.test.ts` (new describe). **Why not 5:** see Findings |
| Spec fidelity | 20 | 4 | 3 | 16.0 | The contracts match the plan's § API contracts: `SummaryAnswer` (`summary.routes.ts:49-66`), strict query (`query.ts:39-55`), one 404 body (`summary.ts:69`), `no-store` set before anything can throw (`summary.routes.ts:97`). Also `MeetingProject` (`view.ts:51-63`), `currentPeriod { from, to, ended }`, `projectManagerId: string \| null` (`activity-host.routes.ts:63`), `ownerUserId: string` (`crm-api/.../resolve.routes.ts:101,178`), `projectId` with exactly one of three filters (`meetings-api/src/system/hosts.routes.ts:46,87,137`), `hours.hostHours` (`shell/src/lib/extensions.tsx:69,85`), and the event in a byte-identical copy (`shared:check`). Every reinterpretation is in `decisions.md`: event built from props, guard stricter, `byWorkType` all time, `dealId`+`projectId` allowed together, `summaryRequestOf` exported. Drift was amended into plan and spec before code relied on it: T3 `currentPeriod` on the terms routes (`b50325c3`), D85/A52/R8 (`668e5f0d`, `7ce1fcdf`), T19 column wording (`a6bcbae4`). The additions no AC asks for are listed by design as droppable: the `identities`/`authz` notes, the grouping banner, the hints. **Why not 5:** the release notes understate the accepted limitation (Findings) |
| Test quality | 20 | 5 | 3 | 20.0 | **Tests verify behaviour, not shape, and catch regressions.** Of my **31 mutations, all 31 were killed**. They covered: left going negative, truncation in place of half up, a package asked for all time, the block re-reading for any project, Expired always shown, the server's "today" shown as an end, wire validation dropped (both apps), the divider always drawn, the region never `hidden`, the panel ignoring the event's kind, no empty state, the event naming the wrong kind, the guard accepting extra members, a missing `on.project` read as unknown, a hidden project named, export columns 7/8 swapped, the refusal lost on My hours and on Everyone's hours, the 409 not restarted, the T21 export refusal deal-only, a skeleton on re-read (panel and block), the event dispatched before the save (19 red), a late answer kept, `ended` dropped, a line for an unknown project, a person-table placeholder, the disclosure reset on re-read, focus not restored after Retry, and the grouping banner shown on the wrong grouping. QE killed 6 more (the oracle's 3, and M1–M3 on the table view's restart). Backend tests run the assembled app against real Postgres with fake owners. They assert exact groups, call logs (who was asked and with which credential: `record.test.ts:101`, `figures.test.ts:285`), byte-identical 404s (`record.test.ts:49-90`), every owner outage failing closed, auth's refusal-30 s / grant-never caching (`people.test.ts:214-238`), and legacy owners that omit the member (`:271`). Edge cases are covered: 29 February, the expiry day inclusive, before the start, NUL and 65-character ids, reversed or half windows, a burst of events, abort and late answers, malformed answers. The e2e uses an independent period oracle (`project-hours.spec.ts:219`) |
| Code quality & conventions | 15 | 4 | 3 | 12.0 | The code follows the house patterns. The owner clients parse strictly and read a missing member as "not stated, never a grant" (`clients/projects.ts`, `crm.ts`). The labels mirror the deal's twin with ONE hosts read (`labels/resolve.ts:181-206`). Every read fails closed: 503 rather than a low figure (`filters.ts:109-118`), and `byPerson` is withheld when `auth` is down (`summary.ts:107-115`). The summary's figures are one REPEATABLE READ snapshot with the total summed from the groups (`summary.ts:127-148,199`). `packagePeriod` is pure calendar integer arithmetic. Both UIs validate the wire before showing a figure (`HostHoursModel.ts:57-62`, `projects-ui/src/lib/hoursApi.ts:43-50`). The UIs abort superseded reads and drop late answers, and reuse `useResource` `keepDataOnRetry`. Copy is in en/it catalogs, colours are token utilities, and there is no new dependency. Every API used exists: Prisma `groupBy`/`aggregate`/`$transaction` with `isolationLevel`, `Intl.DateTimeFormat#formatToParts`. Lint and typecheck are clean in all four frontends. **Why not 5:** see Findings |
| Design fidelity (UI) | 15 | 4 | 3 | 12.0 | design.md is complete. It has flows F1–F8, a states table per part with four failure combinations, and an a11y plan covering headings, the disclosure (`aria-expanded`/`aria-controls` to an always-mounted `hidden` region), focus after Retry, spoken durations and 320 px. Reuse is mapped (24 reuse, 4 new). Gaps G1–G6 were resolved by the owner. The build realises it. The card sits right after Details (`ProjectDetailPage.tsx:265`) and after Meetings on the deal page (`DealDetailPage.tsx:265`). The frame always shows and only the slot swaps (`projects-ui/.../HoursSection.tsx:45-64`). "Over by" has no colour (screenshot `variant-over-1280-light.png`). The "Expired" `StatusBadge voided` sits beside the dates (`ConsumptionBlock.tsx:65-72`). The disclosure is built as designed (`HostHours.tsx:179-191`). QE walked it at 320/360/1280, light and dark, en and it, with keyboard and contrast measured (lowest 4.87), and axe ran in `HoursSection.test.tsx:413`. **Why not 5:** see Findings |
| Trajectory | 10 | 2 | 2 | 4.0 | **No `wellforge-run/v3` trace for this feature exists in `.forge/runs/`.** The newest traces are meeting-hours' (2026-11-24, 2026-11-25), and the brief says this run's trace is written after this eval. Per the rubric and the evaluator rule, this is the neutral floor, as earlier evals in this repo scored the same situation (`specs/20261116-letterhead-service`, `specs/20261115-crm-offer-wizard`). Git and the hook events corroborate (Findings) but do not replace the trace |
| **Total** | **115** | | | **92.0 → 80.0/100** | normalised: 92.0 / 115 × 100 = **80.00** |

**Verdict: PASS.** 80.0 against a `pass_score` of 80, and every applicable dimension is at or above its floor. **The margin is zero.**
AC satisfaction (4/4) and trajectory (2/2) both sit exactly on their floors. A one-anchor drop anywhere makes this a FAIL:
- spec fidelity 4→3 gives 76.5;
- test quality 5→4 gives 76.5;
- code quality or design 4→3 gives 77.4;
- AC satisfaction or trajectory one lower falls below its floor.

The written run trace, if it matches git and the hook events below, would lift trajectory to 4 (83.5).

## Findings

### AC satisfaction: 4 (on its floor)
- **Thin evidence (test, no observed behaviour):**
  - AC-2.7 (a project awaiting its manager) is integration-only (`people.test.ts:239-270`, projects-api resolve test); QE could not build an
    awaiting project live.
  - AC-4.11 is unit-only (`tableGrid.test.ts`, a new describe).
  - AC-4.10 was observed only through a rewritten response, not a real Meetings outage.

  That is the 4 anchor's "one or two thin".
- **A judgement the reader should see: A52.** A page left open across a Zurich date keeps its day:
  - AC-1.1 and AC-1.3: the period, and "up to today";
  - A51: "not started";
  - AC-1.9: "Expired";
  - AC-2.8: the block does not follow a save in cases (a)–(c).

  `plan.md` says so in its own words: the AC-1.1 and AC-2.8 test rows read "not met by a page open across …". I count these ACs as met because
  the owner accepted the behaviour into the approved spec as assumption A52 (D85, 2026-11-27), and the code matches A52 exactly. QE O5 agrees,
  and so does `consumption.ts:107-118`: the window is `currentPeriod` as read with the page. The ACs hold in the normal flow, live: e2e C on
  the project and visibility B on the deal. **If a reviewer reads A52 as an unmet AC rather than a scoping assumption, AC-2.8 is only
  partially satisfied, this dimension falls to 2 and the verdict is FAIL.** I did not take that reading: the spec is the contract, and the
  owner amended it before this eval.
- **To reach 5:**
  - an awaiting-manager journey in e2e (AC-2.7);
  - an observed table-view check for AC-4.11;
  - the R8 "way out" (re-read the project on the event), which removes A52's cases (a)–(c).

### Spec fidelity: 4
- **The release notes understate the accepted limitation.** A52/D85 was widened to four cases at 08:44 (`7ce1fcdf`). Two minutes later T19
  (`49bc0be5`) wrote three documents that each describe **only case (a)**, the open-ended capacity package:
  - the changeset's "Known limitation" (`.changeset/project-hours-card-and-consumption.md`);
  - AGENTS.md (lines 77-79);
  - infra/README.md (lines 3915-3917).

  None of them mentions case (b), the yearly anniversary, case (c), the start date arriving, or case (d), "Expired" only after a reload.
  Behaviour is unaffected, but what reaches users and operators is narrower than what the owner accepted. Fix: one sentence in each of the
  three files (docs only).
- Otherwise the build matches its contracts. Each drift was amended before code relied on it, and each reinterpretation is recorded.
- **What would lower it:** an undocumented contract difference. I found none: I compared `summary.routes.ts`, `query.ts`, `view.ts`,
  `hosts.routes.ts`, both resolve answers and `extensions.tsx` against plan § API contracts.

### Code quality: 4
- **A component copied from another app, against AGENTS.md § Frontend** ("never copy a component from another app"):
  `projects-ui/src/components/ConsumptionBlock.tsx:17` re-implements hours-ui's `Duration` (`hours-ui/src/components/EntryRow.tsx:33`). It
  is deliberate and recorded (design § Component inventory, "lift when next touched", because of the live-shell deploy rule), so it is a nit
  with a reason, not a slip.
- **A third hand-made disclosure** (`HostHours.tsx:179-191`), after meetings-ui and projects-ui. AGENTS.md says a pattern a second app needs
  goes into `@operai/ui`. Also recorded and deferred by design.
- **A misleading name:** `DealFilterUnavailable` (`hours-ui/src/components/DealFilterUnavailable.tsx:30`) now renders the project refusal too
  (`kind`, `HostFilterKind`), so the name says less than the component does.
- **A cast:** `summary.ts:133` casts `row.userId as string` inside a conditional groupBy shape.
- **To reach 5:** lift `Duration` and a `Disclosure` into `@operai/ui` and rename the refusal component. These are follow-ups, not defects.
- **What would make it 3:** a stricter reading of AGENTS.md's "never copy" rule, one that does not accept the design's recorded deferral.

### Design fidelity: 4
- **design.md keeps superseded text** that only § Gap resolutions (line 606, "These override the text above") cancels:
  - line 56, "hours left (negative when exceeded)";
  - line 167, "−4 h 30 (a real minus sign)";
  - line 301, "Nothing in the widget changes when someone records hours in place (G5)";
  - line 419, "Considered and not designed: … an 'expired' cue (G3), a Refresh action (G5)";
  - line 430, the spoken "over" twin;
  - line 522, the `leftSpoken`/`overSpoken` copy row.

  A reader building from S1 or the Copy table would build the wrong thing.
- **The front matter is still `status: draft`** (line 3).
- **QE found two design-versus-code contradictions (D1, D3).** In both, the code was right and design.md was amended.
- **Cosmetic and a11y items open** (QE O2–O4):
  - the period's date range wraps at 1280 when four facts share the row (visible in `variant-over-1280-light.png`);
  - the focus ring on the Consumption group sits flush against its text;
  - an empty total is spoken "0 seconds";
  - at 320 px a long unbroken name pushes Time out of view.
- **QE O1** (the open breakdown closed itself twice, not reproduced). I checked the seam:
  - `HostExtension` reloads only on `[name]`, and its boundary is keyed by `resetKey` (`shell/src/lib/extensions.tsx`);
  - a reset on re-read is caught by tests (mutation S8);
  - the page unmounts the card only through its own load states (`ProjectDetailPage.tsx`, `recordChanged` → `resource.retry()` after a failed
    project re-read).

  Nothing points at this feature. It remains an unexplained observation.
- **To reach 5:** strike the superseded passages (or fold the resolutions into S1, S3, Copy and Accessibility), set `status`, and fix the
  date-range wrap and the focus-ring inset.

### Trajectory: 2 (neutral floor)
- There is no run trace. The evidence that would support a 4 once the trace exists:
  - **Hook events** (`.forge/runs/.events.jsonl`, 2026-11-26/27, WellForge agents only):
    - adr-writer ×4 and designer ×3 (11-26);
    - architect, then devops T5 (15:49Z);
    - backend-dev and frontend-dev in two parallel waves (06:54Z–07:34Z);
    - architect drift amendment (07:06Z);
    - product-owner/architect for D85 (07:32Z, 07:43Z);
    - quality-engineer T18 (07:41Z), devops T19 (07:47Z), owasp-reviewer (07:54Z);
    - quality-engineer pass 1 (08:35Z), architect (08:38Z), quality-engineer pass 2 (09:18Z);
    - designer D1 fix (09:22Z), quality-engineer (09:27Z), designer D3 fix (09:29Z), quality-engineer pass 3 (09:37Z).
  - **Git order:** spec → plan/design/ADRs → tasks (`2ce3ed26`…`99964632`) → T5 restack → T1–T4/T14/T15/T17 → T10/T11 → T6/T7 → T12/T13/T16 →
    T8/T9 → T21 → T19 → T18 → QE ×3 with two fix rounds (the cap).
  - Every code commit is tagged with its task, and decisions are recorded per task.
- Author times show the parallel waves interleaved, as worktree isolation allows. Dependencies held: T8 (08:18) after T7 (08:01); T9 (08:32)
  after T8; T13/T16 after T10/T11/T15.
- **Gaps even with a trace:**
  - the branch was rebased mid-run, so committer dates are all 09:02;
  - QE pass 1 found a neighbouring e2e regression (D2) that T11/T18 had missed. QE fixed it, but in test code it changed itself.

### Test quality: 5
- Residual gaps, none of which reaches the 4 anchor's "edge cases missing", because every link is pinned:
  - **QE O6:** no single test runs the List's 409 restart as one chain, or the export button's alert after the third refusal. Everyone's hours
    has no page-level 409 test; the shared hook covers it, and my mutation H11 killed it through `useHoursQuery.test.tsx`.
  - **No test pins A52's accepted behaviour.** Only the request shape is pinned (`consumption.test.ts:276`).
- I did not run the backend suites (by instruction). Backend quality is judged from reading `src/summary/*.test.ts`,
  `entries/projectFilter.test.ts` and `totals/projectMeetings.test.ts`, plus QE's runs and mutations.

## Recommended next step
- **PASS → the spec may move to `done` (T20).**
- Before or with the close, docs only and not blocking:
  1. Widen the "known limitation" sentence in the changeset, AGENTS.md and infra/README.md to all four A52 cases.
  2. Strike or fold design.md's superseded passages and set its status.
  3. Write this run's `wellforge-run/v3` trace, which is the one item that moves trajectory.
- Owner follow-ups already offered: the owasp low (projects-ui's block receives `byPerson` on the wire for a PM and discards it; ask the
  summary without people, or accept), the `Duration`/`Disclosure` lift into `@operai/ui`, and the R8 way out.

**Verdict: PASS — 80.0/100 (default-v2; AC satisfaction and trajectory on their floors; zero margin).**

Self-critique: this PASS sits exactly on the threshold, and three of my calls each decide it. First, reading A52 as a scoping assumption
rather than an unmet AC-2.8. Second, test quality 5 rather than 4. Third, code quality 4 despite a documented copy of another app's
component. I made each from cited evidence, not to land on 80. The first two are the ones I would defend least casually: the first rests on
the owner's amendment, the second on 31/31 frontend mutations plus reading, not running, the backend suites.
