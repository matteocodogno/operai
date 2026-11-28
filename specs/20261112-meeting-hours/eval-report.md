---
spec: 20261112
evaluated: 2026-11-25
rubric: default-v2
score: 83.5
verdict: PASS
---
# Eval report: Meeting hours — the hours of a meeting recorded automatically for the people who took part

Previous pass: PASS 86.1 at `48ec8690` before the rebase (`efc69b48` after it), on 2026-11-25. Before that: PASS 80.0. This pass re-scores
every dimension from the evidence at HEAD `71393244` and carries no score over.

**Rubric:** `default-v2`. I used the tool-bundled copy at `~/.claude/plugins/cache/wellforge/wellforge/2.61.0/config/eval-rubric.yml`,
found through `installPath` of the `wellforge@wellforge` entry for this project in `~/.claude/plugins/installed_plugins.json`.
Neither `gates/configs/eval-rubric.yml` nor `.wellforge-gates/gates/configs/eval-rubric.yml` exists. The spec has no `eval.md`, so no
overrides apply. `design.md` exists, so the conditional `design_fidelity` dimension applies and the weight pool is 115.

**What I evaluated:** the whole feature at HEAD, `git diff a17c260f...HEAD` (58 commits; base `origin/main` `a17c260f`). The PR #12
cleanup is `3bf7c402..HEAD`:
- six code commits: `ee0c8c09` T22, `ff1cf2a1` T23, `50e6fa05` T24, `0773d58a` T19, `aba5691a` T20, `0cc70ab0` T21;
- one comment-only test commit, `3921c3c6`;
- the spec non-goal reword (ledger D77), plan § Amendment 2026-11-25, tasks T19–T26, the QE cleanup pass (PASS) and the owasp T25 delta
  (PASS).

`qe-report.md` ends at **PASS**, not BLOCKED. Its top section is the cleanup pass. I did not run the backend suites, as the brief asked
(they can truncate dev databases). QE's backend runs stand: meetings-api 2150 pass in 93 files and hours-api 2117 pass in 51 files, both on
`*_test`.

**What I checked myself.** Apart from this report I edited nothing in the repo, and `git status` showed no other change when I finished.

| Check | Result |
|---|---|
| hours-ui `pnpm lint`, `pnpm exec tsc -b`, `pnpm test` | lint 0, tsc 0, **2798 pass, 95 files**, the same as QE |
| `mise run shared:check` | 35 groups in sync, `meetingHoursWire` and `systemAuth` included. `cmp` finds the two wire files identical |
| `node scripts/check-changeset.mjs --base=$(git merge-base HEAD origin/main) --head=HEAD` | OK, matched `.changeset/meeting-hours-automatic-entries.md` |
| Invariants I2, I4, I8 since `3bf7c402` | the prisma diff is empty and no `console.` line changed; the test numstat is 6 files, **0 deleted lines**, 235 added; the wire, `hours-ui/src/strings` and `check-shared-copies.ts` are untouched |
| `3921c3c6` (a commit after QE PASS) | comment lines only: the two changed lines are `//` lines |
| The rebase | `git patch-id` is identical for five sampled pairs of pre- and post-rebase commits (`4bcddbed`/`a870bc10`, `33822e97`/`520ea8be`, `d5c46eb1`/`0610106b`, `48ec8690`/`efc69b48`, `c3c963b3`/`fe2318a4`) |
| **My own mutations** (hours-ui, run in a `git archive` copy under `/tmp` that I deleted afterwards) | M-A, Everyone's hours drops `<FromMeetingBadge>`: **8 red** (`EntriesTable.test.tsx`, `EntriesTable.it.test.tsx`). M-B, the mark moved before the kind badge in `EntryRow`: **4 red** (`EntryRow.test.tsx` "right after the kind badge and before the name", the hidden meeting, moved to another meeting, moved off and back) |

| Dimension | Weight | Score (/5) | Floor | Weighted | Since last pass | Evidence |
|---|---|---|---|---|---|---|
| AC satisfaction | 35 | 4 | 4 | 28.0 | = (4) | **All 28 ACs are met.** Each has an executed test (qe-report § AC sweep, 28/28). After the cleanup they are re-proven by the green suites (QE: 2150 / 2117 / 2798) and by `meeting-hours.spec.ts` + `meeting-hours-moved.spec.ts`, **8/8 twice in a real browser**, with screenshots B1–E1. **The ACs the cleanup touches:** AC-2.5 (`blockDeletedEntry(tx, …)`, `entries.routes.ts:405`; a refused block takes the delete back, `automatic.test.ts:275`); AC-1.1, AC-1.2 and AC-3.3 (one participant reader, `participants.ts:15-22`, used at `record.ts:74` and `delivery.ts:81`); AC-3.1–3.4 and AC-3.8 (the snapshot lock, `record.ts:71`, pinned by `record.test.ts:63`); AC-2.3 and AC-4.3 (`FromMeetingBadge`; 16 renders byte-identical before and after). **Still thin (test or behaviour, not both):** AC-1.6 is shown by structure only (`matrix.test.ts` pins the one `/system/` route, the `sub` allowlist, and `apply.ts` as the only writer of `origin: "meeting"`). AC-2.2's export clause is inferred from the shared walk: no workbook test holds an `origin: 'meeting'` entry. AC-3.8 is covered by the I-M `prepareAudio.measured.test.ts` inside the green run; its real-stack e2e was not re-run after `readHoursFacts` changed (QE O4: the dev stack again holds 3 job runners) |
| Spec fidelity | 20 | 4 | 3 | 16.0 | = (4) | **The cleanup is the approved amendment, step for step.** S1 (`lock.ts:12-20`), S2 (`participants.ts`), S3 (`FromMeetingBadge.tsx`), S4 (`rules.ts:47`; `isRecordNotFound` at `entries.routes.ts:52`, used at `:383` and `:397`), S5 (`blocks.ts`) and S6 (`delivery.ts:30-31`, `client.ts:26`). Every done-when grep holds (QE rows 14–19). I1–I9 hold: no wire, OpenAPI, migration, log line, copy, env, scope, dependency or export change. The spec's only change is the D77 non-goal, which now says what the build does (`origin` stays on the wire); no stale "nothing shows it was automatic" sentence is left anywhere in the repo. The plan was corrected after implementation (S2's undetectable `orderBy` mutation, S5's failure mode, S6's check, `810dffaa`), openly and with decisions recorded. The extra tests beyond the plan are recorded in decisions.md (T19–T24). **What keeps it at 4:** **AGENTS.md:763** still defines **Untouched** as "any saved change of day, duration, note or target". That is the pre-A39 wording, named in the last eval and still not fixed. `design.md`'s inventory says "NEW: none" and draws the `Badge` inline, while the code now has `FromMeetingBadge`: the newer plan amendment supersedes it and the DOM is identical, but the design file was not updated. The earlier documented trivia stand (`on?.type`; the unreachable `invalid_notice`; the adapted `systemAuth` header). The env-doctor test fix `d9673794` rides on the branch, recorded as a baseline environment fault in the trace |
| Test quality | 20 | 5 | 3 | 20.0 | = (5) | **The cleanup's tests are characterisation tests that check their own preconditions:** the second-connection `FOR UPDATE SKIP LOCKED` probe of the lock (`record.test.ts:63`); `null`, not a 404 (`:77`); the mixed-case participant order, which fails on a collation that agrees with JavaScript (`deliverHoursNotice.test.ts`, `participants.test.ts`); index scans turned off with `SET LOCAL`, so the case can see a dropped `orderBy`; a raising `BEFORE INSERT` trigger and a constraint trigger deferred to COMMIT, the only test that tells `tx` from `db` (`automatic.test.ts:275`, `:301`); `dayDate` checked in four process zones; the badge's tone pinned for the first time. **They fail when the behaviour breaks:** QE's 12 cleanup mutations each turned the named test red, and my M-A and M-B did too. The feature's own tests are as last pass found them: U, I-H, I-M, C, C-M and E levels; two-connection races; all-or-nothing under a fault; the A36 and A42 vectors on both sides; and my earlier MA–MJ mutations |
| Code quality & conventions | 15 | 4 | 3 | 12.0 | **↓ 5 → 4** | **The production code is better than at the last pass.** The six items PR #12's review found in the code that pass scored 5 are fixed. The worst was two participant reads in two orders for one fact; the others were two copies of the lock SQL with different missing-row behaviour, the badge drawn twice, the helpers repeated, the block rule in the route, and unqualified AC citations. The new helpers are small and documented, and their contracts are explicit: `lockMeetingRow` never throws, `lockMeeting` throws the identical 404, and `blockDeletedEntry` takes an object so two string ids cannot be swapped and catches nothing. No `try/catch` swallows anything, and no dependency changed. **What holds it at 4 (minor nits, all cosmetic):** (1) `automatic.test.ts:17-18` and `rules.test.ts` import twice from a module they already import (`bun:test`, `./rules`), on purpose, so that I8's "0 deleted test lines" holds literally (decisions T23/T24, QE O3). That is code shaped to a metric, not idiom, and hours-api has no lint to catch it. (2) The feature's own `apply.ts:116` still repeats the inverse day conversion (`toISOString().slice(0, 10)`), which the amendment observed and left. (3) `Prisma.TransactionClient` cannot stop `blockDeletedEntry(db, …)` from compiling (owasp C3); only a grep and one test guard it |
| Design fidelity (UI) | 15 | 4 | 3 | 12.0 | = (4) | design.md is complete: F1–F5, S1–S5, every state, an a11y plan with measured contrast (4.99 / 6.29), four hotspots, and reuse mapped. The cleanup keeps S1 and S2 exact: 16 renders are byte-identical (`class="badge badge-accent"`, the same test id), the e2e runs 8/8 twice, and M-A and M-B show the placement is pinned. Hotspot 2 is stronger than last pass: the tone can no longer change unnoticed (`FromMeetingBadge.test.tsx`). Reuse is honoured: `FromMeetingBadge` wraps the library `Badge` and adds nothing. **Not done, as before:** the VoiceOver/NVDA listen of hotspot 1 (design.md:417, 457), a fresh measurement of contrast and of zoom (design.md:427, "zoom itself not run"), and G7 observed in a browser (it was observed through the API timeline instead) |
| Trajectory | 10 | 4 | 2 | 8.0 | = (4) | The `wellforge-run/v3` trace exists. This run's trace is written after this eval, so for the cleanup round the evidence is the hook events in `.forge/runs/.events.jsonl`. On 2026-11-25 they show: product-owner 09:11Z, architect 09:25Z, product-owner 09:54Z (spec and tasks, `e7037591`), backend-dev 09:56Z (stopped on the missing Prisma client, decisions.md), frontend-dev 10:00Z (T22), backend-dev 10:05Z (T23 → T24), backend-dev 10:10Z (T19 ∥ T20 → T21), architect 10:17Z (plan corrections, `810dffaa`), owasp-reviewer 10:17Z (T25), quality-engineer 10:25Z (PASS), backend-dev 10:25Z (comment follow-up `3921c3c6`). Every one is a WellForge agent, and each commit lands in its task's dependency order. Verification ran and was not waived: the owasp delta, then QE with 12 mutations and the e2e. **Why not 5:** the trace is a reconstruction (`"reconstructed": true`, no per-agent timestamps, `tokens` null). Its commit hashes and the older QE section's hashes are pre-rebase objects on no branch: I verified they are patch-identical, but they do not resolve on the branch. The round of 2026-11-25 08:08Z made a code-comment edit by a non-WellForge agent (`caveman:cavecrew-builder`, recorded in the trace). One commit landed after QE PASS, and I verified it is comment-only |
| **Total** | **115** | | | **96.0 → 83.5/100** | **was 86.1** | normalised: 96.0 / 115 × 100 = 83.48 |

**Verdict: PASS.** 83.5 against a `pass_score` of 80, and every applicable dimension is at or above its floor. **AC satisfaction sits exactly
on its floor (4/4).** One AC found unmet, or its evidence found weak, would make this a FAIL whatever the total. The margin above 80 is 3.5
points. A one-anchor drop in spec fidelity or test quality would land on exactly 80.0 (still a pass). A one-anchor drop in design, code
quality or trajectory would land between 80.9 and 81.7.

## Findings

### Code quality & conventions: 4 (was 5)
- **Why it moved:** the last pass gave 5 and found nothing. PR #12's review then found six code-quality items in that same code, and the
  cleanup fixed every one. That 5 was generous. The code at HEAD is cleaner than the code it was given for. What decides the anchor is that
  concrete nits remain, and anchor 4 is "Clean and conventional; minor nits".
  - `hours-api/src/entries/automatic.test.ts:17-18` (`import { spyOn } from "bun:test"` beside the existing `bun:test` import) and
    `hours-api/src/entries/rules.test.ts` (a second `import { dayDate } from "./rules"`). They were written that way so the I8 numstat
    reads "0 deleted". The invariant's purpose is "no existing test weakened", and merging an import line weakens nothing.
  - `hours-api/src/meetingHours/apply.ts:116` repeats the `Date` → `YYYY-MM-DD` conversion that `view.ts:171`, `list.routes.ts:62` and
    `totals/totals.ts:18` also hold (plan amendment § Observed, not planned).
- **To reach 5:** merge the two duplicate imports (it costs two deleted test lines; the I8 check would need to accept import-line merges).
  Optionally, a `dayText` beside `dayDate` in `rules.ts`, used by `apply.ts`. Owner: backend-dev.

### AC satisfaction: 4 (floor 4, met; unchanged)
- **The cleanup is behaviour-preserving, and the evidence agrees.** QE traced the SQL before and after: the statements, their order and
  their count are identical, and the one planned difference is `ORDER BY` on the lock-time read. The DOM before and after is identical.
  The suites are green. The real-browser journeys pass 8/8 twice.
- **Still thin (each "test OR behaviour, not both"):**
  - **AC-1.6** (CRM call and meeting activities record nothing) is proven by structure. That is the right proof for a negative, but it is
    not observed behaviour.
  - **AC-2.2's export clause** has no test with an automatic entry in the workbook. It holds because the export walks the same complete
    list (`HoursExport.tsx` → `readAllEntries`) and the workbook has no branch on `origin`.
  - **AC-3.8 after the cleanup:** `readHoursFacts` now locks through `lockMeetingRow`, and `prepareAudio.ts`'s step-3 commit calls it.
    The I-M `prepareAudio.measured.test.ts` passes in QE's meetings-api run, but `meeting-hours-measured.spec.ts` was not re-run on a
    clean stack after the change (QE O4).
- **To reach 5:** a `hoursWorkbook` case with an `origin: 'meeting'` entry (owner: frontend-dev), and a re-run of
  `meeting-hours-measured.spec.ts` after a dev-stack restart (owner: quality-engineer).

### Spec fidelity: 4 (unchanged)
- **Still open from the last pass:** AGENTS.md:763 (it was :757) defines **Untouched** as "any saved change of day, duration, note or
  target". spec A39 and `.claude/context/glossary.md:222-225` say any edit the person saves counts, values not compared, and AGENTS.md:524
  ("any saved `PATCH` clears `followsMeeting`") already says so. The file disagrees with itself. Owner: the orchestrator, a one-line edit at
  close.
- **New, documentation only:** design.md § Component inventory (lines 333 and 346, "NEW: none") still draws the mark as an inline `Badge`
  in both components. Since T22 it is drawn by `FromMeetingBadge`. Plan § Amendment S3 is the newer contract and the DOM is identical, so
  this is not divergence. A one-line note in design.md would keep the design the source of truth for the UI. Owner: designer or
  orchestrator.
- The plan corrections after implementation (S2, S5, S6) are recorded in decisions.md and in the plan's own header line. That is the
  workflow working as intended, not drift.

### Design fidelity (UI): 4 (unchanged)
- The screen-reader listen (hotspot 1) is still not done. Its fix, if it reads badly, is a visually hidden comma. Contrast and the
  320–375 px reflow are the designer's measurements on a fixture, and zoom was never run. G7 was observed through the API timeline, not in
  the browser. Owner: quality-engineer, with a person who has VoiceOver or NVDA.

### Trajectory: 4 (unchanged)
- The cleanup round ran the right WellForge agents in dependency order, and verification ran after the code (owasp delta, then QE). Hook
  events and commit times agree.
- Gaps:
  1. The cleanup round is not yet in a trace. The orchestrator writes it after this eval, so it should list the post-rebase commits.
  2. The existing trace and the older QE section cite pre-rebase hashes (for example `4bcddbed`, `c3c963b3`) that are on no branch.
     Their post-rebase equivalents are patch-identical (checked), but a reader cannot follow those references on the branch.
  3. The earlier non-WellForge comment edit (`efc69b48`) stays in history.
- Owner: the orchestrator. Write this run's trace with post-rebase hashes, and add a line mapping the old hashes to the new ones.

### Open items outside the ACs (from the pipeline's own reports; noted, not scored)
- **R9 pre-merge check**: real-recorder sessions of 2 and 15 min and one interrupted and resumed session, plus 10-minute m4a and webm
  uploads. None of them should log a `duration_corrected` line. It is the only evidence of whether max(30 s, 10 %) leaves honest
  recordings alone, and it needs a person with a microphone. It is still not done. Owner: the owner, **before the merge** (plan § Risks,
  infra/README § The measured duration).
- **QE O4 / EF-1:** the dev meetings-api has accumulated three job runners under `bun --hot` again. Restart the stack before reading a red
  `meeting-hours-measured.spec.ts` as a defect. The hazard is pre-existing and not this feature's.
- The scratch test databases named in the trace's environment faults are left for the owner to drop.

## Recommended next step
- **PASS.** No AC needs revisiting, so T26 may proceed and `/wellforge:done 20261112-meeting-hours` may run. Before or at close:
  1. **The owner runs R9's real-recorder check before the merge.** It is the one precondition the plan itself sets.
  2. The orchestrator corrects AGENTS.md:763's **Untouched** to match A39. It writes this run's trace with post-rebase hashes.
  3. Optional, toward 5s:
     - backend-dev merges the two duplicate test imports;
     - frontend-dev adds a workbook test with an automatic entry;
     - the quality-engineer re-runs `meeting-hours-measured.spec.ts` on a freshly restarted stack, and does the VoiceOver/NVDA listen;
     - the designer notes `FromMeetingBadge` in design.md's inventory.
