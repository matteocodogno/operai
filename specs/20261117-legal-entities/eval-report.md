---
spec: 20261117
evaluated: 2026-11-18
rubric: default-v2
score: 78.3
verdict: FAIL
---
# Eval report (round 3): Legal entities — one registry of the group's companies, for every tool

**HEAD evaluated:** `664eee77` on `feat/legal-entities` (equal to `origin/feat/legal-entities`, clean tree). Round 3
runs at the owner's explicit request (2026-11-18), after round 1 (FAIL 76.5) and round 2 (FAIL 78.3).

**Round 2's commit is `b682c810`, not `3db7dbe4`.** No object `3db7dbe4` exists in this repository: no ref, no
reflog entry, `git rev-parse --verify` fails. The hash appears only in the run trace (`.forge/runs/…legal-entities.json:887`),
and from there it reached this round's brief. The range evaluated is `git log b682c810..HEAD`: 27 commits, 37 files,
+2670/−209.

**What changed since round 2.**
- **Governance:** the replica arithmetic is corrected in `plan.md:1357-1359`, R24 (`:1575`) and `cache.rs:49-53`
  (`ccc641a1`, `256ca63f`, `471d0d7c`). Owner approvals are recorded (`d1da2ecc`; tasks.md "Owner, 2026-11-18"):
  every orchestrator decision, design.md (`status: approved`), the T51 copy, and DR-14/DR-17. The QE delta for T77
  is qe-report.md §15, and the CI flake is triaged there as FU-14 (`10d815e5`, `d7d144db`).
- **D9 (the owner's N1 decision):**
  - spec amendment `269090f1` and `2e6c4a23`: AC-9.11, AC-9.12 and AC-9.16 change; OQ-14 to OQ-16 and R-D9a are
    added;
  - plan "Amendment 2026-11-18 — D9", J1–J13 (`11664e4e`);
  - ADR D9-1 (`a01c9e62`) and an AGENTS.md line;
  - T78 copy (`2780051a`, `3b38c626`);
  - product code: T80 `eacd65ea`, T79 `62781f27`, T81 `1cd5d326`, T88 `91eeb87d`, T89 `8490f348`;
  - changesets `536e45dd`, `a79680fc` and `9e66d3a2`;
  - e2e T84 `1685569b`;
  - OWASP delta `4938917b`: PASS WITH NOTES, N1 closed;
  - QE §16 `b02cf03f`: PASS, including a test fix in the T84 spec.
- **Product files changed:** auth (`notices/{duty,content,copy,dispatcher}.ts`, two migrations, `schema.prisma`,
  `index.ts`), notify-api (`emails.schemas.ts`, `emailTemplates.ts`, `index.ts`), shell e2e, and a comment-only
  change in `letterhead-api/api/src/registry/cache.rs`.

**Rubric.** Same as rounds 1–2. Neither `gates/configs/eval-rubric.yml` nor `eval.md` exists, so this is
**default-v2**:

| Dimension | Weight | Floor |
|---|---|---|
| AC satisfaction | 35 | 4 |
| Spec fidelity | 20 | 3 |
| Test quality | 20 | 3 |
| Code quality | 15 | 3 |
| Design fidelity | 15 | 3 |
| Trajectory | 10 | 2 |

Design fidelity applies because `design.md` exists. `pass_score` is 80, and the total is normalised over 115.

**Verification evidence for this round.**
- **What I re-ran locally:**
  - `node scripts/check-changeset.mjs --base=origin/main --head=HEAD` exits 0, and all 12 changesets match.
  - Nothing else. This host has no `bun` (not on PATH, not in `~/.bun`, not installed under mise), no
    `node_modules` in the worktree, and no cargo. The auth and notify-api suites are `bun test`, so I could not run
    them, even with the provided `auth_t85`/`notify_t85` databases.
  - **For auth (1430/0) and notify-api (649/0), the e2e (15/15), the skew rehearsal and the live T88 checks, I rely
    on QE §16** (qe-report.md:536-604).
- **What I read by hand:**
  - every D9 product diff line by line: `duty.ts:72-90`, `content.ts:30-48, 95, 177-190, 241-256`, `copy.ts` against
    the design.md N1 table (identical, en and it), `dispatcher.ts:164-167, 210-240, 264-272`, both migrations, the
    notify-api schema and template, and both `onError` handlers;
  - the D9 tests: `content.test.ts:270-281` (static scan) and `:286ff` (longest case), `dispatcher.test.ts:1038-1230`,
    `duty.test.ts:467ff, :721`, `auth.mount.test.ts:207-242`;
  - the OWASP D9 delta, QE §15 and §16, plan J1–J13, the D9 ADR, and the design.md diff;
  - the run trace, checked commit by commit against git.
- **CI:** `gh run list --branch feat/legal-entities` shows **no run since round 2**. The newest runs are still at
  `f2912337`:
  - `letterhead-api` 44231760303 is red (attempt 1, never re-run). FU-14 explains it: a pre-existing race,
    reproduced on `origin/main` at 23/50 under load (§15.3).
  - `env-doctor` is red. It was red on `origin/main` before; it is not counted.
  - `react-skew` and `shared-copies` are green.
  - `changeset-check` has not run since `fcaedf07`. The local run above passes.
  - No CI workflow covers auth, notify-api or the e2e. QE's local runs are the only execution evidence for D9.

| Dimension | Weight | Score (/5) | Floor | Weighted | Evidence |
|---|---|---|---|---|---|
| AC satisfaction | 35 | **4** | 4 | 28.0 | **D9 ACs have executed evidence** (qe-report.md §16.1:540-544):<br>• AC-9.11: the J8 rows, and e2e journeys 14 and 15 in en and it, with in-app and email read at the fake Resend. The captured address survives a live rename and an email change between save and retry (§16.4:596).<br>• AC-9.12: the sentinel display name is in no notice, row or log, and the address is absent from both services' logs (§16.3:584). The 400 body does not echo the value (`emails.routes.test.ts`). The strict schema refuses `actorName` (`emails.schemas.ts:138`).<br>• AC-9.16: imports run and write 0 notice rows (§16.3:585).<br>• AC-9.10: the outside row carries the same address at integration level only (`dispatcher.test.ts:1042`). It is not live, because `LEGAL_ENTITY_NOTICE_EMAIL` is unset (§16.3:586).<br>The code matches the AC:<br>• the address is read through `tx` after the version is stored (`duty.ts:72-73, 86-89`), not from the session;<br>• there is no name fallback (`content.ts:177-189`; the template at `emailTemplates.ts:437-449`);<br>• R-D9a: an unusable address gives null and a log line without the value (`dispatcher.ts:267-272`).<br>O-1/N1, which weakened US-9 in rounds 1–2, is closed.<br>**Not 5, unchanged in kind:**<br>• the production halves of AC-3.2, AC-7.1–7.5 and AC-9.10 wait on T15–T18, T48, T49 and T71. T87 (R26 count) is also open. These are unverified, not unmet;<br>• AC-9.13's push leg and the outside mailbox were never exercised live (§16.7:626);<br>• AC-9.15's "no recipient" is unit-level only. |
| Spec fidelity / no drift | 20 | **4** | 3 | 16.0 | **Round-2 findings mostly closed:**<br>• The replica arithmetic is correct in all three places ("about six replicas", `plan.md:1357-1359`, R24 `:1575`, `cache.rs:49-53`).<br>• DR-14 is consistent between design.md:786 and tasks.md.<br>• Owner approvals are recorded in tasks.md.<br>**D9 is handled as drift should be:**<br>• owner decision → spec amendment marked per AC, with OQ-14 to OQ-16 → plan J1–J13, with superseding text pointed at ("this block wins", `plan.md:1594`) → an ADR that amends the two ADRs it touches → AGENTS.md → design;<br>• QE's changeset drift (§16.7) was fixed (`9e66d3a2`);<br>• the T88 rule change is restated in the ADR (point 2), the plan (J13), `duty.ts:15-20` and `schema.prisma:433-436`.<br>**Not 5:**<br>(1) **Two ADRs still contradict themselves on approval, the round-2 finding:**<br>• The D3 ADR's status line (`docs/adr/20261118-a-dialog-…md:4`) says "approved by the owner on 2026-11-18" and, in the same line, "no separate owner approval is recorded".<br>• The pin ADR (`…409-at-once.md:4`) says "approved by the owner on 2026-11-18" and also "no owner approval of the numbers (1 s, the budget, crm-api's 1.1 s wait) is recorded". tasks.md says the owner approved exactly those numbers.<br>(2) R-D9a is written into AC-9.11's contract text as an orchestrator reading (spec.md, "R-D9a, orchestrator 2026-11-18"). The plan still calls it "proposed for the owner" (`plan.md:1863-1869`), and design.md:793 says "proposed … applied meanwhile". The marking is honest, but an unapproved rule now sits inside an AC, against the header's "Nothing in US-9 is left unconfirmed".<br>(3) The OWASP info D9-5 is not acted on: the ADR (`…one-personal-value…md:116-117`) still says the push provider receives the address. The reviewer showed that the payload is RFC 8291 ciphertext.<br>(4) The pin ADR's file name and title still say 100. This is acceptable by its note. |
| Test quality | 20 | **4** | 3 | 16.0 | **Stronger on D9:**<br>• sentinel tests both ways: the name nowhere, the address only where allowed (`dispatcher.test.ts:937-1000, 1042-1067`);<br>• a clock test with the actor renamed, email changed and soft-deleted (`:1110`);<br>• byte-identical address across retries, and the clear in the terminal update (`:1155`);<br>• the DB trigger/CHECK test (`:1201`), a pre-D9 row (`:1215`), and a static scan for the display-name column (`content.test.ts:276-281`);<br>• the 320-character longest case;<br>• notify-api: a hostile local part escaped, no `mailto:`, `actorName`/missing/invalid/321 → 400 with no echo, and T89 log privacy;<br>• QE ran on real databases: auth 1430/0, notify-api 649/0, e2e 15/15, a live skew in both directions, and live trigger refusals (§16.3:579-582).<br>**Against:**<br>(1) **`auth.mount.test.ts:207-242` (D9-2) can pass vacuously.** It records Better Auth's status with `console.info` and does not assert it. It has no positive control that the session cookie was accepted: in the 4th case, `name: "Renamed"` is never checked. With a rejected cookie, every case is green. It also does not distinguish "change-email disabled" from "change-email enabled with a verification step" (the fixture is `emailVerified: true`, so the email would not change either way). QE's live 400 `CHANGE_EMAIL_DISABLED` / `EMAIL_CAN_NOT_BE_UPDATED` (§16.5:603) is the real evidence, and it is not pinned.<br>(2) T84's e2e was ticked "Playwright green" but failed 2 of 15 at head against T88 (the 09:23 code vs the 09:27 test), until QE fixed it (§16.6:611-616). The first journey's audit count is sensitive to leftovers of an aborted run (§16.6:617-619).<br>(3) **No CI run at HEAD, or at any commit since `f2912337`.** `letterhead-api` is still red on the FU-14 race. It is triaged with an owner, but not fixed or re-run. auth, notify-api and e2e have no CI at all.<br>(4) Unchanged: no mutation evidence for the rule core; FU-12; the push leg and the outside mailbox are not live; no focus assertion in the busy state. |
| Code quality & conventions | 15 | **4** | 3 | 12.0 | **D9 code is small and idiomatic:**<br>• one rule (`noticeAuthorEmail`, `content.ts:37`), shared by expression with notify-api's `ToSchema`/`actorEmail`;<br>• one primary-key read, only when there are rows (`duty.ts:72-73`);<br>• the invariant is enforced by the database, not by convention: a trigger restricted to `UPDATE OF "authorEmail"` plus the CHECK `status = 'pending' OR "authorEmail" IS NULL`, after clearing existing rows first (migration `20261118120000…`);<br>• the clear happens in the same `updateMany` as the terminal status (`dispatcher.ts:213, 240`);<br>• both `onError` handlers log name and code only (`auth/src/index.ts:145-147`, `notify-api/src/index.ts:62-69`);<br>• the comments state the rule and its reason.<br>**Against:**<br>• the auth `onError` line runs far past the file's width (`index.ts:147`);<br>• info items left open: D9-4 (zod parity between the two services is held only by matching exact pins, and no shared corpus test exists), D9-8 (the unusable-address line repeats on every attempt);<br>• carried from round 2: after a failed forced refresh, every read goes to auth (`cache.rs:277-281`); the older-epoch waiter (`:297-303`); D3-1's missing `inFlight` guard (`LegalEntityForm.tsx:397-400`); T76-3 (silent budget refusal); N3, N5, N6, O-2; per-replica limiters;<br>• QE §16.4:598 found that an auth build between T80 and T88 cannot deliver against a T88 database. No shipped order produces this. It is a runbook note that is not in plan J7 "Rollback" (`plan.md:1807-1810`). |
| Design fidelity (UI) | 15 | **4** | 3 | 12.0 | **Closed since round 2:**<br>• design.md is `status: approved` (`:3-4`), and the T51 copy review and DR-14/DR-17 are owner-approved (`:780-793`);<br>• the S12 busy reading is owner-approved (`:788`);<br>• T78 is complete: DA-6 (`:55`), closed slots (`:397`), the four `byAction` keys en/it and the email rows (`:412-415, :440`), and a worked example with an address (`:428`);<br>• the longest case was recomputed for a 320-character address (Italian body 909, push 1092 B, `:432`), and DR-17 names the lock-screen address (`:766`);<br>• `copy.ts` matches the design table word for word in en and it.<br>**Not 5:**<br>• the a11y justification of the busy state is still unverified: design.md:700 says "accepted because … the busy label is announced". Confirm is natively `disabled` while focused (`ConfirmDialog.tsx:162, :170`), there is no live region, and nothing (axe, the unit test, QE) checked where focus goes or what is announced. The owner approved the *decision*, not the claim. Round 2's routing (a real-browser focus check) was not done;<br>• the "Still open, for the owner" heading now lists ticked items (`:791-795`). This is cosmetic. |
| Trajectory | 10 | **3** | 2 | 6.0 | **Better:**<br>• QE ran after every product commit: §15 after T77, and §16 at head `1685569b` plus its own test fix, after T88/T89 (09:44Z vs 09:23Z);<br>• the bounded loop was respected: round 2 escalated to the owner, and round 3 runs at the owner's request (tasks.md);<br>• the owner's decision went spec → plan → tasks → design → code → OWASP → fixes of its lows → QE in a traceable order;<br>• the red CI was triaged with a reproduction on `origin/main` and an owner (FU-14);<br>• the trace's `finished` (`09:46:07Z`) now equals HEAD's commit time, T44 reads "prepared", and `f31feb1e` is moved.<br>**Holding it at 3, because the trace is still not faithful to git, the defect round 2 named:**<br>(1) entry 83 cites the evaluator commit **`3db7dbe4`, which does not exist**. The real one is `b682c810`;<br>(2) entry 88 credits the product-owner with `1cd5d326` (T81's auth code), `11664e4e` (plan) and `264d0199` (tasks);<br>(3) entry 90 credits the adr-writer with `11664e4e` (the plan). The ADR commit `a01c9e62` appears nowhere;<br>(4) entry 97 (owasp, T86) has `commits: []`, although `4938917b` is its commit;<br>(5) entry 86 cites `f8c0f4db`, a worktree commit that is not on the branch, instead of `10d815e5`;<br>(6) 12 branch commits since round 2 are in no entry (`b682c810`, `10d815e5`, `d7d144db`, `471d0d7c`, `a01c9e62`, `3b38c626`, `4938917b`, `e60e1435`, `6130121a`, `f6a3fdbf`, `9e66d3a2`, `664eee77`);<br>(7) `4c9a6842` is still credited to both architect (entry 79) and adr-writer (entry 81), as in round 2, and `ccc641a1` is now credited twice;<br>(8) `notes` still says "Owner decision open: N1/O-1";<br>(9) there is no drift event for spec amendment D9 or for the T84/T88 contradiction;<br>(10) entry 98 records T84 as "PASS", but its done-when was false at head until QE fixed the test (§16.6).<br>Separately, the OWASP lows' fixes (T88: a new trigger and a CHECK) were not re-read by the owasp-reviewer. QE judged it unnecessary (§16.8:634). This is a smaller deduction than round 2's, because QE did run after them |
| **Total** | 115 | | | **90.0 / 115 = 78.3/100** | |

**Verdict: FAIL.** 78.3 is below `pass_score` 80 (92/115 needed; 2 weighted points short). No dimension is below its
floor: AC satisfaction 4 is at its floor of 4, and trajectory 3 is above its floor of 2. The product work since round
2 is good. The score does not move because none of the round-2 routes to a higher anchor was completed:
- **Trajectory:** the trace still carries an invented hash and misattributions.
- **Spec fidelity:** the ADR approval contradictions remain.
- **Design fidelity:** the busy-state focus check was not run.

D9 added work of the quality the existing scores already reflect.

## Round 1 and Round 2 (history)

- **Round 1** (`5640de49`, report in `dc658437`): **FAIL 76.5** (88/115). Scores: AC 4, spec 4, tests 4, code 4,
  design 4, trajectory 2 (no run trace). Routed: the trace, untick T44, an OWASP delta on T76/D2/D3, ADRs 5–8, the
  plan/ADR sync, S12/Open items, CI at HEAD, and the owner items (N1/O-1, T51 copy, DR-14).
- **Round 2** (`690e712d`, report in `b682c810`): **FAIL 78.3** (90/115). Scores: AC 4, spec 4, tests 4, code 4,
  design 4, trajectory 3.
  - Trajectory rose with the trace.
  - It held at 3 because T77 had landed after the last QE and OWASP verdicts, and the trace held an invented
    `finished`.
  - New findings: the false replica arithmetic, ADR/DR-14 approval contradictions, an unverified S12 busy
    justification, and the unrecorded red `letterhead-api` run.
- **Round 3** (this report): **FAIL 78.3**, with the same scores. Fixed since round 2:
  - QE now runs after the code;
  - the arithmetic is corrected;
  - the approvals are recorded;
  - N1 is closed by D9;
  - the flake is triaged.

  It is still FAIL for the reasons in the verdict above.

## Owner-pending items: how this eval treats them

These are open by design and **not** counted as unmet. They cap AC satisfaction at 4:
- release steps T15–T18, T48, T49 and T71;
- T87 (the R26 count; if it is not 0, the owner decides R-D9a before T48);
- O-4 (outside the feature);
- the Resend residency note (D9-6);
- notify-api notification-body retention (ADR D9 :116).

If T18 reports `mismatched` above 0 or an unaccepted `ibanPrintChanged`, AC-7.5 is unmet and a re-eval fails on the
floor.

## Findings and who owns them

Each of the first two items is worth +2 weighted points on its own (trajectory 3→4 gives 92/115 = 80.0, PASS with
zero margin). Both together give 96/115 = 83.5.

- **Trajectory 3 → 4** (orchestrator): make the trace faithful to git, and check it mechanically before the next
  eval:
  - every `commits` hash must resolve (`git cat-file -e`) and be an ancestor of HEAD;
  - every commit in `b682c810^..HEAD` must appear in exactly one entry with the right agent. Specifically:
    - `3db7dbe4` → `b682c810`;
    - `f8c0f4db` → `10d815e5`;
    - remove `1cd5d326`, `11664e4e` and `264d0199` from the product-owner entry;
    - adr-writer → `a01c9e62`;
    - owasp T86 → `4938917b`;
    - add T88/T89 docs `e60e1435`/`6130121a`, `3b38c626`, `f6a3fdbf`, `9e66d3a2`, `471d0d7c` and `d7d144db`;
    - de-duplicate `4c9a6842` and `ccc641a1`.
  - update `notes` (N1 decided);
  - add drift events for D9 (owner decision → spec amendment) and for T84 vs T88;
  - record T84's outcome as "completed; done-when failed at head against T88, fixed by QE in `b02cf03f`".
  - Optional: have the owasp-reviewer add a three-line entry for `91eeb87d`/`8490f348` (the trigger, the CHECK and
    the handlers).
- **Spec fidelity 4 → 5** (adr-writer/architect; owner for R-D9a):
  - delete the stale clauses "no separate owner approval is recorded" (D3 ADR :4) and "no owner approval of the
    numbers … is recorded" (pin ADR :4);
  - reword the D9 ADR's compliance note on push providers (D9-5);
  - get the owner's yes or no on R-D9a and record it in spec.md, plan J11 and design.md:793 (or rely on T87 = 0 and
    say so).
- **Design fidelity 4 → 5** (frontend-dev/designer): in a real browser, press Confirm in S12 and record where focus
  goes and what a screen reader announces while busy. Then either make design.md:700's sentence true (for example
  `aria-disabled` plus a polite status) or replace it with what was observed. Assert focus in
  `LegalEntityForm.protected.test.tsx`.
- **Test quality** (backend-dev; devops):
  - in `auth.mount.test.ts:207-242`, assert the 400 codes QE saw live (`CHANGE_EMAIL_DISABLED`,
    `EMAIL_CAN_NOT_BE_UPDATED`) and add a positive control (an `update-user {name}` with the same cookie renames);
  - fix the FU-14 test race (wait for the killed worker to die) and re-dispatch `letterhead-api`, `changeset-check`
    and `env-doctor` at HEAD;
  - make the e2e audit count robust to leftovers of an earlier run;
  - unchanged: a mutation pass on the rule core, FU-12, and a live check of the push leg and the outside mailbox.
- **Code quality** (backend-dev; frontend-dev):
  - wrap `auth/src/index.ts:147`;
  - D9-4: a shared email corpus test in auth and notify-api;
  - D9-8: log once per row;
  - add the rollback note of QE §16.4 to plan J7 "Rollback": never run an auth build below T88 on a T88 database;
  - carried: D3-1's `inFlight` guard, T76-3, and the T77 fallback improvements.

## Recommended next step

FAIL. Do not move the spec to `done`; T47 stays open. The bounded loop already counted two rounds, and this third
round was the owner's. Whether a fourth runs is the owner's decision. The routes to PASS are documentation and
test-assertion fixes, not product rework:
1. **Orchestrator:** correct the run trace against git (as listed above), then re-request `/wellforge:eval`.
2. **`/wellforge:implement 20261117-legal-entities`:**
   - adr-writer: the two ADR status lines and D9-5;
   - backend-dev: the D9-2 test assertions, FU-14, and the `index.ts:147` wrap;
   - frontend-dev/designer: the S12 busy-state focus check;
   - devops: re-dispatch CI at HEAD.
3. **Owner:** R-D9a; T87 before T48; release steps T15–T18, T48, T49, T71; the Resend residency and notify-api
   retention notes.
