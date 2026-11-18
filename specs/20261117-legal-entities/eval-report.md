---
spec: 20261117
evaluated: 2026-11-18
rubric: default-v2
score: 80.0
verdict: PASS
---
# Eval report (round 4): Legal entities — one registry of the group's companies, for every tool

**HEAD evaluated:** `11528d34` on `feat/legal-entities` (equal to `origin/feat/legal-entities`, clean tree). Round 4
runs at the owner's explicit request (2026-11-18), after rounds 1–3 (FAIL 76.5, 78.3, 78.3).

**Range evaluated:** `git log c8290ae1..HEAD`, 8 commits, 10 files, +1047/−390. Most of the line count is the run
trace. There are four content commits:
- `d9b9f73d` (docs: ADR status lines, D9-5, S12, plan J7);
- `ea65ad2a` (the auth test and the `index.ts` wrap);
- `5aee2d2a` and `40c6b262` (R-D9a confirmed).

The other four are trace regenerations: `33aa16ca`, `37fe655c`, `7acb6e45` and `11528d34`.

**Product code changed:** `auth/src/index.ts:147-151` only, a pure re-wrap with the same three arguments (diff
checked). Everything else is tests, docs or the trace.

**Rubric.** Same as rounds 1–3. Neither `gates/configs/eval-rubric.yml` nor `eval.md` exists, so this is
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
- **Re-ran locally:**
  - `node scripts/check-changeset.mjs --base=origin/main --head=HEAD` exits 0, and all 12 changesets match;
  - a mechanical check of the run trace against `git log origin/main..HEAD` (Python, read-only). Results are under
    Trajectory.
- **Could not run:** this host has no `bun` (not on PATH, not in `~/.bun`, not in Homebrew, not under mise), no
  `node_modules` and no `cargo`. Because of that:
  - the auth, notify-api and letterhead-api suites and the e2e cannot run here, and no databases were created;
  - **the changed `auth.mount.test.ts` (`ea65ad2a`) has no execution evidence anywhere**: not in the commit, not in
    tasks.md, not in qe-report.md, and not in CI.
- **Relied on:** QE §16 (`b02cf03f`) for auth 1430/0, notify-api 649/0 and e2e 15/15 at `1685569b`/`b02cf03f`.
  Since then the only product change is the formatting-only `index.ts` wrap.
- **CI** (`gh run list --branch feat/legal-entities`): **no run since `2026-11-18T03:37Z`**, which is commit
  `f2912337`, four rounds of commits ago:
  - `letterhead-api` 44231760303 is red. This is FU-14, a pre-existing race reproduced on `origin/main` (QE §15.3).
  - `env-doctor` is red, and it is red on `origin/main` too.
  - `react-skew` and `shared-copies` are green.
  - The last CI run of `changeset-check` (44199883645) is red. The local run above passes.
  - No workflow covers auth, notify-api or the e2e.

## Round-3 findings: status at `11528d34`

| Round-3 finding | Status | Evidence |
|---|---|---|
| Trace: non-existent `3db7dbe4` | **Fixed** | Entry 124 = `b682c810`. `notes` (`.forge/runs/…legal-entities.json:1766`) records the correction. |
| Trace: commits missing, duplicated or not on the branch | **Fixed** | Mechanical check: all 161 cited hashes are in `origin/main..HEAD`, none is duplicated, and they are in git order. `committed_at` equals each commit's committer date (0 mismatches) and `outcome` equals each subject. The only missing commit is `11528d34`, the trace's own commit, which cannot cite itself. `finished` `09:59:52Z` equals HEAD's time. |
| Trace: product-owner credited with `1cd5d326`/`11664e4e`/`264d0199`; adr-writer with the plan | **Fixed** | Entries 141 (backend-dev T81), 132 (architect), 133 (orchestrator), 135 (adr-writer `a01c9e62`). |
| Trace: owasp T86 → `4938917b` | **Not done** | Entry 143 credits `4938917b` to the **orchestrator**. No owasp-reviewer entry exists for T86, although T46, T42, T43, T68 and T84 have verdict-only entries (161–165). |
| Trace: `notes` still had N1 open; no D9 drift event; T84 recorded as PASS | **Fixed** | `notes` says "N1 decided as D9 (closed)". There is a D9 drift event (owasp-reviewer → spec.md). Entry 165 records "2 of 15 failed at head after T88 until QE T85 fixed the test". The T84/T88 conflict is not a `drift_events` item, which is acceptable. |
| Spec: D3 ADR and pin ADR status lines contradicted themselves | **Fixed** | Both `:4` lines now say the owner approved on 2026-11-18. The pin ADR names the numbers (1 s, 30/600 s, 1.1 s). |
| Spec: R-D9a sat in AC-9.11 unapproved | **Fixed, with a new stale clause** | spec.md:284 says "confirmed by the owner 2026-11-18". tasks.md:1377 records the owner's confirmation, as do ADR D9 point 3 (`:20`) and design.md:793. **But `plan.md:1876-1877` still says "until the owner confirms or rejects it, the plan applies it"**, and `:1871` quotes the old spec marking. Both sit under a heading (`:1869`) that says "confirmed". See Findings. |
| Spec: D9-5, the push provider "receives the address" | **Fixed** | ADR D9 `:116-117`: Web Push relays RFC 8291 ciphertext; Resend, devices and the outside mailbox are named as the real readers. |
| Design: S12 busy-state a11y claim unverified | **Claim withdrawn, check not done** | design.md:700 now says the announcement and focus are "**unverified**". design.md:794 adds an open item (VoiceOver/NVDA, owner QE/designer). There is still no focus assertion in `LegalEntityForm.protected.test.tsx`. |
| Tests: `auth.mount.test.ts` D9-2 could pass vacuously | **Fixed in code, not executed** | `:243-248` is a positive control: `get-session` returns 200 with the fixture's id and email. `:254-255` asserts 400 and the codes QE saw live (`CHANGE_EMAIL_DISABLED`, `EMAIL_CAN_NOT_BE_UPDATED`, qe-report.md:603). The same cookie helper is accepted in T74's test (`:170-181`, a 422 needs an authenticated manager), so the risk is low. Nobody ran it. |
| Tests: FU-14 race, CI not re-dispatched | **Not done** | No CI run since 03:37Z (see above). |
| Code: `auth/src/index.ts:147` too long | **Fixed** | `:147-151`. |
| Code: plan J7 lacked the T88 rollback note (QE §16.4) | **Fixed** | `plan.md:1812-1817`, with a preferred rollback (redeploy the head build). |
| Code: D9-4, D9-8, D3-1 `inFlight`, T76-3, T77 fallback items | **Open** (unchanged) | Info-level items; not routed for this round. |

## Score

| Dimension | Weight | Score (/5) | Floor | Weighted | Evidence |
|---|---|---|---|---|---|
| AC satisfaction | 35 | **4** | 4 | 28.0 | **Unchanged from round 3.** The only product change is a formatting-only wrap, so the AC evidence of QE §16 still holds:<br>• AC-9.11, AC-9.12 and AC-9.16 executed (qe-report.md §16.1-16.4);<br>• the code matches the ACs: `duty.ts:72-90`, `content.ts:37-47, 177-189`, `dispatcher.ts:213, 240, 267-272`;<br>• R-D9a, the AC-9.11 clause, is now owner-confirmed (spec.md:284).<br>**Not 5:**<br>• the production halves of AC-3.2, AC-7.1–7.5 and AC-9.10 wait on T15–T18, T48, T49, T71 and T87. These are unverified, not unmet;<br>• AC-9.13's push leg and the outside mailbox were never exercised live (§16.7);<br>• AC-9.15's "no recipient" is unit-level only. |
| Spec fidelity / no drift | 20 | **4** | 3 | 16.0 | **Closed since round 3:**<br>• both ADR status lines are consistent;<br>• R-D9a is confirmed and recorded in spec, tasks, ADR and design;<br>• D9-5 is corrected in the ADR;<br>• spec.md:23 "Nothing in US-9 is left unconfirmed" is now true.<br>**Not 5:**<br>(1) **New stale contradiction, introduced by `5aee2d2a` itself.** plan J11's heading (`plan.md:1869`) says "confirmed by the owner". The same bullet still says "spec.md AC-9.11 carries it marked 'R-D9a, orchestrator 2026-11-18'" (`:1871`; the spec now adds "confirmed by the owner"). It ends with "It is in AC-9.11 as an orchestrator reading; until the owner confirms or rejects it, the plan applies it" (`:1876-1877`). This is the class of defect (an approval line contradicting itself) that held this dimension at 4 in rounds 2 and 3.<br>(2) tasks.md:1333 ("If the count is not 0, the owner has decided R-D9a … before T48") now reads as a condition that is already met. This is harmless.<br>(3) The pin ADR's file name and title still say 100. This is acceptable by its note. |
| Test quality | 20 | **4** | 3 | 16.0 | **Better:**<br>• the D9-2 test now pins the premise: a positive session control (`auth.mount.test.ts:243-248`), then status 400 plus the exact Better Auth code, then the stored email unchanged (`:254-258`). This closes round 3's "vacuous pass" finding in the code;<br>• the D9 test body from round 3 still stands (sentinels both ways, clock and rename/email-change/soft-delete, byte-identical retries, the trigger/CHECK test, the 320-character case, notify-api 400s with no echo).<br>**Against, held at 4:**<br>(1) **The rewritten test has never been executed.** `ea65ad2a` carries no run evidence, QE did not re-run it after round 3, and no CI covers auth. Exact-code assertions that nobody ran are a claim, not evidence. The risk is low (T74's test proves the same cookie helper is accepted, and the codes match QE's live run), but it is unproven.<br>(2) **CI:** no run at HEAD, or at any commit after `f2912337`. `letterhead-api` is still red on FU-14, which round 3 routed to devops (fix the race, re-dispatch) and which was not done. auth, notify-api and the e2e have no CI.<br>(3) Unchanged: no mutation evidence on the rule core; FU-12; the push leg and the outside mailbox are not live; no focus assertion for the S12 busy state; the e2e audit count is sensitive to leftovers of an aborted run (§16.6:617-619). |
| Code quality & conventions | 15 | **4** | 3 | 12.0 | **Closed since round 3:**<br>• `auth/src/index.ts:147-151` is wrapped, with identical semantics;<br>• the T88 rollback hazard is in the runbook (`plan.md:1812-1817`), with the safe path named.<br>**Not 5 (carried, info-level):**<br>• D9-4: zod parity between auth and notify-api is held only by matching exact pins, and there is no shared corpus test;<br>• D9-8: the unusable-address line repeats on every attempt;<br>• D3-1: the missing `inFlight` guard (`LegalEntityForm.tsx:397-400`);<br>• T76-3: a silent budget refusal;<br>• after a failed forced refresh, every read goes to auth (`cache.rs:277-281`), and the older-epoch waiter (`:297-303`);<br>• per-replica limiters;<br>• N3, N5, N6, O-2. |
| Design fidelity (UI) | 15 | **4** | 3 | 12.0 | **Better, because now honest:**<br>• design.md:700 no longer claims that "the busy label is announced". It states what is known (Confirm and Cancel natively `disabled`, Escape and × ignored, the dialog open until the answer) and marks the screen-reader announcement and focus target as **unverified**;<br>• design.md:794 opens a real-browser VoiceOver/NVDA check with an owner;<br>• the rest is as in round 3: `status: approved`, the T51 copy and DR-14/DR-17 owner-approved, T78 complete, `copy.ts` identical to the N1 table in en and it.<br>**Not 5:**<br>• the S12 hotspot still has an a11y plan item with no evidence. A natively disabled, focused Confirm can drop focus to `<body>` in some browsers, and nothing shows that it does not;<br>• the "Still open, for the owner" heading (`:790`) lists ticked items and now a QE/designer item. This is cosmetic. |
| Trajectory | 10 | **4** | 2 | 8.0 | **The round-3 blocker is fixed, and I verified it mechanically** (Python against `git log origin/main..HEAD`):<br>• 166 entries: 161 with one commit each, plus 5 verdict-only entries;<br>• every hash resolves, is on the branch, and appears once, in git order;<br>• every `committed_at` equals the committer date, and every `outcome` equals the subject;<br>• only the self-referencing `11528d34` is absent;<br>• `notes` disclose the rebuild and the `3db7dbe4` → `b682c810` correction;<br>• there is a D9 drift event, and T84's real outcome is recorded (entry 165);<br>• `verdicts` lists QE §15/§16, the OWASP deltas and eval rounds 1–3.<br>The workflow order is sound: QE after every product change up to `b02cf03f`, OWASP on D9 before QE, and rounds 3 and 4 explicitly requested by the owner (tasks.md:1377).<br>**Not 5. Gaps, all in the attribution heuristic ("agent from the commit's task tag or type", `notes`):**<br>(1) **No owasp-reviewer entry for T86.** `4938917b`, the D9 security delta, is credited to the orchestrator (entry 143, `:1480`). Round 3 named this fix explicitly. The parallel T70 commit `b75b49d9` (same shape: review file plus tasks.md) is credited to owasp-reviewer, so the heuristic is inconsistent.<br>(2) `dc658437` (`:1226`) is credited to the orchestrator only, although it holds eval round 1's report and the OWASP T76/D2/D3 delta. There are no evaluator or owasp entries for those dispatches.<br>(3) **`ea65ad2a` (test code, co-authored by Sonnet like the backend-dev commits `91eeb87d`, `8490f348` and `1cd5d326`) is credited to the orchestrator** (entry 156, `:1608`). That is probably wrong. If it is right, the orchestrator wrote test code itself.<br>(4) `40c6b262` is credited to adr-writer by type (`:1644`), 11 s after an orchestrator commit that edits the same ADR with the same model. This cannot be verified.<br>(5) The verdict-only entries 161–165 duplicate dispatches that already have commit entries, sit after the end of the timeline, and carry no timestamp. The `notes` description of them ("verdict-only dispatches") is therefore inexact.<br>(6) A test change (`ea65ad2a`) was committed with no verification step after it, and round 3's CI re-dispatch was not done.<br>None of these contradicts git, and the gates did run, so this is a 4 with gaps, not the round-3 3 for an unfaithful trace. |
| **Total** | 115 | | | **92.0 / 115 = 80.0/100** | |

**Verdict: PASS.** The score is 80.0, equal to `pass_score` 80, with **zero margin**. No dimension is below its
floor: AC satisfaction 4 is at its floor of 4, and trajectory 4 is above its floor of 2. The pass comes from one
change: trajectory went from 3 to 4 because the trace is now faithful to git. Every other dimension holds at 4. Any
regression in any dimension, including a red auth suite at the first run of the rewritten D9-2 test, turns this into
a FAIL.

## Findings and owners

None of these blocks the PASS. Together they are the distance to a margin.

- **Spec fidelity 4 → 5** (architect): in `plan.md:1871` and `:1876-1877`, delete "until the owner confirms or
  rejects it, the plan applies it", and update the quoted spec marking to "R-D9a, orchestrator 2026-11-18, confirmed
  by the owner 2026-11-18". Optionally reword tasks.md:1333 as decided.
- **Test quality** (backend-dev or QE; devops):
  - run the auth suite once at HEAD (`bun test` with the T85 databases) and record the result for
    `auth.mount.test.ts` (D9-2) in qe-report.md or tasks.md;
  - fix FU-14 (wait for the killed worker to die) and re-dispatch `letterhead-api`, `changeset-check` and
    `env-doctor` at HEAD;
  - unchanged: make the e2e audit count robust, a mutation pass on the rule core, FU-12, and a live check of the push
    leg and the outside mailbox.
- **Design fidelity 4 → 5** (QE/designer): the real-browser S12 check (design.md:794). Record where focus goes and
  what is announced while busy. Then fix it if needed (for example `aria-disabled` plus a polite status) and assert
  focus in `LegalEntityForm.protected.test.tsx`.
- **Trajectory 4 → 5** (orchestrator):
  - add an owasp-reviewer T86 entry, so that `4938917b` is credited to the reviewer or the dispatch is recorded
    beside the merge commit;
  - add evaluator r1 and owasp-delta entries for `dc658437`;
  - re-credit `ea65ad2a` to the agent that wrote it;
  - place verdict-only entries in time order, with timestamps;
  - add this round's evaluator entry.
- **Code quality** (backend-dev; frontend-dev), carried: D9-4 (a shared email corpus test), D9-8 (log once per row),
  D3-1 `inFlight`, T76-3, and the T77 fallback items.

## Owner-pending items: how this eval treats them

These are open by design and **not** counted as unmet. They cap AC satisfaction at 4:
- release steps T15–T18, T48, T49, T71;
- T87, the R26 count. R-D9a is now decided, so a count above 0 is handled by the confirmed rule;
- O-4, which is outside the feature;
- Resend residency (ADR D9 `:117`);
- notify-api notification-body retention (ADR D9 `:116`);
- the S12 real-browser a11y check (design.md:794);
- FU-12 and FU-14, which are test infrastructure.

If T18 reports `mismatched` above 0, or an unaccepted `ibanPrintChanged`, AC-7.5 is unmet and a re-eval fails on the
floor.

## Rounds 1–3 (history)

- **Round 1** (`5640de49`, report in `dc658437`): **FAIL 76.5** (88/115). Scores: AC 4, spec 4, tests 4, code 4,
  design 4, trajectory 2 (no run trace). Routed: the trace, the T44 untick, the OWASP delta on T76/D2/D3, ADRs 5–8,
  the plan/ADR sync, S12 and the open items, CI at HEAD, and the owner items (N1/O-1, T51 copy, DR-14).
- **Round 2** (`690e712d`, report in `b682c810`): **FAIL 78.3** (90/115). Scores: AC 4, spec 4, tests 4, code 4,
  design 4, trajectory 3.
  - Trajectory rose with the trace.
  - It held at 3 because T77 had landed after the last QE and OWASP verdicts, and the trace held an invented
    `finished`.
  - New findings: false replica arithmetic, ADR/DR-14 approval contradictions, the unverified S12 busy claim, and
    the red `letterhead-api` run.
- **Round 3** (`664eee77`, report in `c8290ae1`): **FAIL 78.3** (90/115), with the same scores. D9 (N1 closed) was
  judged good work.
  - Held because the trace still had an invented hash (`3db7dbe4`) and misattributions, the ADR status lines
    contradicted themselves, and the S12 busy claim was unverified.
  - Also routed: R-D9a to the owner, D9-5, the D9-2 test assertions, the `index.ts:147` wrap, the plan J7
    rollback, and FU-14/CI.
- **Round 4** (this report): **PASS 80.0** (92/115). Trajectory 3 → 4 (the trace is faithful to git). Spec, design,
  tests and code are improved within their anchors.

## Recommended next step

PASS, with no margin.
- **T47 may be ticked.** The spec must **not** move to `done` yet: T50 still requires the owner's release chain
  (T16 → T17 → T18 → T87 → T44 → T48 → T49 → T71) and green gates.
- **Before T16:**
  - run the auth suite once at HEAD so the rewritten D9-2 test has execution evidence. A red result there reopens
    this eval;
  - fix plan J11's stale clause;
  - re-dispatch CI after the FU-14 fix.
