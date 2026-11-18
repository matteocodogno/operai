---
spec: 20261117
evaluated: 2026-11-18
rubric: default-v2
score: 78.3
verdict: FAIL
---
# Eval report (round 2): Legal entities — one registry of the group's companies, for every tool

**HEAD evaluated:** `690e712d` on `feat/legal-entities` (equal to `origin/feat/legal-entities`). Round 1 evaluated
`5640de49`. Since then (`git log --oneline 5640de49..HEAD`, 11 commits):
- docs and governance: `caf5564a` (six ADRs and six AGENTS.md lines), `66945ea5` + `7cf84043` (design.md sync),
  `5e8dd828` + `4c9a6842` (plan.md "Sync 2026-11-18 after implementation", H1–H12), `43850795` (forward pointers in
  ADRs 20260714, 20260716, 20261101, 20261105 and ADR-2), `dc658437` (round-1 report, the OWASP delta review of
  T76/D2/D3 in security-review-2.md, the run trace, T44 unticked), `690e712d` (trace update);
- **product code: one commit, `da0b000c` (T77)**: `letterhead-api/api/src/registry/cache.rs` (+48/−12) and tests
  (`tests/registry.rs` +107, `tests/render.rs` +43). It fixes the two lows of the delta review (T76-1: a forced refresh
  dropped the held entry; T76-2: budget 100 per process against auth's per-service 300). No other product file changed
  (`git diff --stat 5640de49 HEAD -- . ':!specs' ':!docs' ':!.forge' ':!AGENTS.md'`).

**Rubric.** Same as round 1: no `gates/configs/eval-rubric.yml` and no `eval.md` exist, so **default-v2** as every
earlier report in this repo applies it: AC 35/floor 4, spec fidelity 20/3, test quality 20/3, code quality 15/3,
design fidelity 15/3 (applies: `design.md` exists), trajectory 10/2; `pass_score` 80; normalised over 115.

**Verification evidence for this round.**
- **QE:** T45 PASS 52/52 (qe-report.md) is fresh for everything except T77. **No QE ran after `da0b000c`**
  (`grep T77` finds nothing in qe-report.md), and the trace's `verdicts.qe` still reports the T45 PASS (trace :957).
- **OWASP:** the delta review (security-review-2.md, "Delta review 2026-11-18") covers `fcaedf07`, `c63a0681`,
  `95ebd129`, the e2e test commits and `caf5564a`: PASS WITH NOTES, 0 medium+, lows T76-1 and T76-2, 4 info. It is
  static. Its two lows were fixed by T77; **T77 itself was not reviewed** (no entry in either security review).
- **CI at `f2912337`** (product code identical to HEAD; only plan.md and the trace changed after):
  - `react-skew`, `shared-copies`: success.
  - `env-doctor`: failure, the one `push.test.ts` test ("the production template ships push off…"), the same failure
    as on every branch run since 2026-11-14 (feat/time-tracking, feat/projects-handoff): pre-existing, not counted.
  - **`letterhead-api` run 44231760303: failure.** fmt, clippy and "Test (workspace, golden corpus, database)" passed
    (that step includes `tests/registry.rs` and `tests/render.rs`, so T77's five new tests ran green against Postgres
    and MinIO). The **release "Worst-case table" step failed**: `pool_replaces_a_worker_killed_while_idle` panicked at
    `api/tests/pool.rs:1084` with `served: WorkerFailed` (37 passed, 1 failed). The pool code and that test are not
    touched by this feature (`git diff origin/main...HEAD -- letterhead-api/api/tests/pool.rs` is empty; only
    `pool/job.rs` gained the `mark_missing` flag), it passed in the debug step of the same run, and every earlier run
    of the step was green, so this is a race (kill -9, then an immediate render) that surfaced now, not a T77
    regression. It is nevertheless a red required workflow at HEAD, and it is recorded nowhere (`grep` in specs/ and
    docs/ finds no mention).
  - `changeset-check` was not re-dispatched since round 1 (last run `fcaedf07`, red on the HEAD~1 base artefact).
- **What I re-ran locally:** nothing new is runnable. The only changed product code is Rust, and this host has no
  cargo toolchain (`mise` refuses the untrusted config; no `~/.cargo`, no rustup). The JS suites I re-ran in round 1
  (admin-ui 1100, crm-ui 1691, letterheads-ui 539, operai-ui 298) cover code that has not changed since. I did not use
  the provided `letterhead_le_t77` database; CI's database step is the evidence for T77's tests.
- **What I read and checked by hand:** the T77 diff line by line (`cache.rs:266-380`, `:387-435`), the six new ADRs'
  status lines and the notices ADR against `auth/src/legalEntities/notices/dispatcher.ts:51-61, :145-161` (retry
  schedule, sweep, lease, batch, timeout all match), the forward pointers, plan H1–H12, the design diff, the run trace,
  `operai-ui/src/components/ConfirmDialog.tsx:87-176` and the busy-state tests.

| Dimension | Weight | Score (/5) | Floor | Weighted | Evidence |
|---|---|---|---|---|---|
| AC satisfaction | 35 | **4** | 4 | 28.0 | Unchanged from round 1: all 52 ACs have executed, passing evidence (qe-report.md §9). T77 strengthens AC-5.5/AC-6.2 without changing their contract: a failed forced refresh keeps serving the entry set aside, bounded at 60 s from its send (`cache.rs:276-314`; `registry_a_failed_forced_refresh_keeps_serving_the_old_entry_within_60_s_of_its_send` checks 60 s exactly usable and +1 ms `Unavailable`); a newer pin during an auth fault gets 409 with `currentVersion`, not 503 (`render_a_failed_pin_refresh_keeps_the_held_entry_for_everybody_else`, green in CI). **Not 5, as in round 1:** the production halves of AC-3.2, AC-7.1–7.5 and AC-9.10 wait on owner steps T15–T18, T48, T49, T71 (unverified, not unmet); AC-9.13's push leg is only indirectly evidenced; AC-9.15 "no recipient" is unit-level; O-1/N1 weakens US-9's purpose while meeting AC-9.11 to the letter. New, small: AC-5.5/6.2 behaviour after T77 has CI-test evidence only, no QE rehearsal |
| Spec fidelity / no drift | 20 | **4** | 3 | 16.0 | **Round-1 findings closed:** (a) ADR candidates 5–8 are written, plus the D3 rule and the pin ADR (`caf5564a`), the four amended/departed ADRs point forward (`43850795`), AGENTS.md has a line for each; I spot-checked the notices ADR against the dispatcher constants and they match. (b) plan.md H1 records the pin rule as built through T77, the 1.1 s crm-api wait, and H2–H12 settle every as-built delta with pointers from the superseded text (plan.md:140, :231, :421, :519, :1010…). (c) design S12 now says what is built. **Not 5:** (1) **A false safety claim was introduced in three places:** "30 keeps about ten replicas, forced and natural reads together, inside it" (plan.md:1355, R24 at :1566, `cache.rs:51`). R24's own inputs refute it: 10 × (30 forced + ~20 natural) ≈ 500 > 300, and 10 × 30 alone already equals the whole allowance; the claim holds to about 6 replicas. Today's impact is nil (one replica, `.railway/railway.ts:22…`), but R24's revisit trigger ("scaled near ten") is wrong, and the delta review's fix asked for `allowance / (replicas × 2)` = 15 at ten replicas. (2) Decisions taken unattended remain unapproved yet are marked settled: the pin numbers (1 s, 30/600 s, 1.1 s: plan H1 "for the owner to review"; the pin and D3-rule ADRs say "no separate owner approval is recorded" but carry `Status: Accepted` and `Deciders: Matteo Codogno (product owner)`), the S12 busy deviation, and DR-14, which design.md:773 ticks as resolved while plan H7 still lists it "for the owner's review". (3) The pin ADR's title and file name still say 100 (amended by note, acceptable, but the record now reads against itself) |
| Test quality | 20 | **4** | 3 | 16.0 | **Better than round 1:** CI ran at product-HEAD and the database step is green, so T77's tests ran for real: joined-flight fallback (`registry_reads_that_join_a_forced_refresh_get_the_old_entry_if_it_fails`, asserts one flight), success drops the fallback and the new entry's own age bounds it, `invalidate()` drops it, a 60 s/+1 ms boundary, and an end-to-end render test. **Against:** (1) **`letterhead-api` is red at HEAD** on an unrecorded flaky test (`pool_replaces_a_worker_killed_while_idle`, `pool.rs:1084`), and nobody has noticed or routed it; `changeset-check` not re-run. (2) T77 has gaps: no test that an unpinned read *during* an auth fault with a still-fresh fallback does not call auth on every request (it does: entry is `None`, so each read starts a flight, `cache.rs:277-281`), and no test of an older-epoch waiter after a newer flight succeeded (it gets `Unavailable` although a fresh entry exists, `cache.rs:297-303`; pre-existing). `registry_the_forced_refresh_budget_is_30_per_10_minutes` asserts a constant against itself. (3) Unchanged from round 1: no mutation evidence for the rule core; gated suites (`CRM_TEST_DATABASE_URL`, committed-transaction groups) are quiet in a plain run; FU-12 open; AC-9.13 push leg indirect; D3 and D2 escaped the unit layer historically. (4) The busy state of the protected dialog has no focus assertion while busy (`LegalEntityForm.protected.test.tsx:300-322` checks the label, Cancel `disabled`, Escape ignored, and focus only *after* the answer) |
| Code quality & conventions | 15 | **4** | 3 | 12.0 | T77 is small and idiomatic: the entry is moved with `take()` into `fallback` under the mutex (`cache.rs:374-376`), cleared on a cached success (`:426-427`) and by `invalidate()` (`:337`); no await under the lock; clippy `-D warnings` and fmt clean in CI. **Against:** the false replica arithmetic is in the constant's doc comment (`cache.rs:49-53`); the rewritten doc comment of `refresh_for_pin` has a run-on line well past the file's width (`:346`); after a failed forced refresh every read goes to auth even while the set-aside entry is younger than 30 s, which spends auth's allowance during exactly the 429 episode T76-1 was about (bounded by single flight and the 60 s cap; not a regression against T76, a missed improvement). Unchanged from round 1: N1 open (owner), N3, N5, N6, O-2, per-replica limiters, FU-12; the delta's info items D3-1 (`confirmProtected` has no `inFlight` guard, `LegalEntityForm.tsx:397-400`), D3-2 and T76-3 (silent budget refusal, A09) are not acted on |
| Design fidelity (UI) | 15 | **4** | 3 | 12.0 | **Round-1 findings closed:** Open items synced and split resolved/owner (design.md:762-785); S12 and its a11y line describe the build, including the dialog mounted beside the form and the `sr-only` list label (:374, :378, :382, :693); S7 records `confirmDisabledReason` (:292-293, :694); FU-5 closed by its ADR; the mockup caveat now points to QE's real-browser check of the built screens (:17). **Not 5:** (1) The S12 busy deviation was resolved by rewriting the design to match the build, and the new justification is unverified: design.md:693 says the deviation is "accepted because … the busy label is announced". With native `disabled` on the focused Confirm (`ConfirmDialog.tsx:162, :170`) the browser's focus fix-up moves focus off the button, and there is no live region for "Saving…"; the only busy-state check is axe, which does not test focus or announcements, and QE took "no action" (qe-report.md:322). The design's original choice (`aria-disabled`, focus kept) was the accessible one. (2) design.md stays `status: draft` and "the owner has not approved it" (:3, :764); the T51 copy review is still open. (3) DR-14 is ticked resolved on an orchestrator decision (:773) |
| Trajectory | 10 | **3** | 2 | 6.0 | **A `wellforge-run/v1` trace now exists** (`.forge/runs/2026-11-17T14-58-00Z-orchestrate-20261117-legal-entities.json`): 83 agent entries in a coherent order (PO → architect → designer → adr-writer → devs in worktrees → QE FAIL rounds T42/T43/T68 with D1–D3 → OWASP T46 → US-9 → T70 → T45 PASS → eval → OWASP delta → doc syncs → T77), 7 drift events, 5 env faults, honest `result: "partial"`. It is not a sanitised single pass. Round-1 routing was followed: T44 is unticked with a status note (tasks.md:492-497), the OWASP delta ran and its lows were routed to T77. **Holding it below 4:** (1) **Product code after the last QE and security verdicts again:** T77 (`da0b000c`) landed after T45 and after the delta review, and neither re-ran; the trace's `verdicts.qe` still reports the pre-T77 PASS (:957). Same deduction as the 20261115 round-2 eval (score 3). Mitigated, not cancelled, by T77 being the reviewer's own prescribed fix and its tests running green in CI. (2) **The trace contains invented data:** `finished` is `2026-11-18T09:30:00Z` (:8), first written as `07:00:00Z`; the commits that wrote them are at 03:31Z and 03:39Z, and this eval ran at about 03:40Z. The skill requires `date -u` at the end of the run; a future timestamp also corrupts `run-report.py`'s token window. (3) The trace lists T44 as `devops` "completed" (:742-744) while tasks.md has it open; `f31feb1e` (the tasks re-sync after the security review) is credited to the post-implementation plan sync (:843); `4c9a6842` is credited to both architect and adr-writer. (4) Historical, from round 1: T60 ticked on a done-when that was false in the browser until D3. (5) The red `letterhead-api` run at `f2912337` was not looked at before the round-2 eval was requested |
| **Total** | 115 | | | **90.0 / 115 = 78.3/100** | |

**Verdict: FAIL.** 78.3 is below `pass_score` 80 (92/115 needed; 2 weighted points short). No dimension is below its
floor: AC satisfaction 4/4 is at its floor, trajectory 3 is above its floor of 2.

## Round 1 (history)

Round 1 (`5640de49`, report committed in `dc658437`): **FAIL 76.5** (88/115). AC 4, spec fidelity 4, test quality 4,
code quality 4, design fidelity 4, trajectory 2 (no run trace). Its routing: write the trace, untick T44, OWASP delta
on T76/D2/D3 (orchestrator); ADRs 5–8, plan/ADR-2 sync for T76 (architect); S12 sync and Open items (designer); CI at
HEAD (devops); N1/O-1, T51 copy, DR-14 (owner). All orchestrator, architect and designer items were done; the delta
review produced T77. Round 2 moves trajectory 2 → 3 (+2). It does not reach 4 because T77 is new unverified code and
the trace carries an invented `finished`. Spec and design fidelity stay at 4 on new findings introduced by the sync
itself.

## Owner-pending items: how this eval treats them

Unchanged from round 1: N1/O-1, release steps T15–T18, T48, T49 and T71 are open by design and **not** counted as
unmet. They cap AC satisfaction at 4. If T18 reports `mismatched` above 0 or an unaccepted `ibanPrintChanged`, AC-7.5
is unmet and a re-eval fails on the floor. O-1 must be decided before T71.

## Findings and who owns them

The cheapest path to PASS is any one of the first three items below (each is worth at least +2 weighted points).

- **Trajectory 3 → 4** (orchestrator, QE, owasp-reviewer):
  - Run a QE delta on `da0b000c`: the Rust registry/render suites plus a live AC-5.5/AC-6.2 rehearsal with auth
    failing during a forced refresh (unpinned 200 from the fallback, newer pin 409 with `currentVersion`, 503 after
    60 s). Record it in qe-report.md.
  - Have the owasp-reviewer read `da0b000c` (it is a fix of their own findings; a short delta entry suffices).
  - Correct the trace: a real `finished` from `date -u`, T44 as "prepared, open until T16", `f31feb1e` removed from the
    post-implementation sync entry, `verdicts.qe`/`owasp` updated after the deltas.
  - Look at the red `letterhead-api` run 44231760303 before asking for the next eval (see test quality).
- **Spec fidelity 4 → 5** (architect, then backend-dev for the comment):
  - Correct the replica arithmetic in plan.md:1355, R24 (:1566) and `cache.rs:51`: either "safe up to about 6
    replicas; revisit before scaling past 5", or lower the budget to 15 if ten replicas must be covered.
  - Make the approval state consistent: DR-14 either "decided by the orchestrator, open for the owner" in both
    design.md:773 and plan H7, or approved by the owner; the two 2026-11-18 ADRs either `Status: Proposed` until the
    owner approves the numbers, or the owner's approval recorded.
- **Design fidelity 4 → 5** (designer and frontend-dev; owner for approval):
  - Verify the busy state in a real browser: where is focus after pressing Confirm, and is "Saving…" announced? If
    focus drops to the body, either use `aria-disabled` + `aria-busy` on Confirm while busy (the original design), or
    move focus to the dialog and add a polite status, and assert it in `LegalEntityForm.protected.test.tsx`. Then make
    design.md:693's justification true.
  - Get the owner's approval of design.md (status) and the T51 copy review.
- **Test quality** (devops / backend-dev): re-run the failed job and record `pool_replaces_a_worker_killed_while_idle`
  as a follow-up (the pool should reap a dead idle worker before handing it a job, or the test should wait for the
  reap). Re-dispatch `changeset-check` with the `origin/main` base. Unchanged: mutation pass on `rules.ts`,
  `ibanTail.ts`, `protectedChanged`, `notices/content.ts`; FU-12; an AC-9.13 push-leg check through auth's notice.
- **Code quality** (owner decision, then backend-dev / frontend-dev): N1; optionally serve a set-aside entry younger
  than 30 s without calling auth after a failed forced refresh, and prefer `state.entry` over `state.fallback` for an
  older-epoch waiter (`cache.rs:297-303`); D3-1's one-line `inFlight` guard; a log line when the pin budget refuses
  (T76-3).

Not credited: the trace's `finished` time; the ADR status "Accepted" where the ADR itself says no owner approval is
recorded; "the busy label is announced", which nothing tested.

## Recommended next step

FAIL. Do not move the spec to `done`; T47 stays open. Route as follows:
1. **Orchestrator:** QE delta and OWASP delta on `da0b000c`; fix the trace; triage the red `letterhead-api` run.
2. **`/wellforge:implement 20261117-legal-entities`:** architect (replica arithmetic, approval states), designer and
   frontend-dev (busy-state focus check, design.md:693), backend-dev (the `cache.rs:51` comment), devops
   (`changeset-check`, the pool flake follow-up).
3. **Owner:** N1/O-1 before T71; T51 copy review; DR-14; approval of design.md and of the pin numbers.
4. Re-run `/wellforge:eval`. Trajectory 4 alone gives 92/115 = 80.0 (PASS with zero margin). Adding spec fidelity 5
   gives 96/115 = 83.5.
