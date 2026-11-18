---
spec: 20261117
evaluated: 2026-11-18
rubric: default-v2
score: 76.5
verdict: FAIL
---
# Eval report: Legal entities — one registry of the group's companies, for every tool

**HEAD evaluated:** `5640de49` on `feat/legal-entities` (equal to `origin/feat/legal-entities`). The diff is
`origin/main...HEAD`: 113 commits and 323 files (+52 343 / −1 334). The last product-code commit is `95ebd129` (D3).
After it, only `shell/e2e` test fixes (`569ea44b`, QE), `qe-report.md` and `tasks.md` changed (`git diff --stat 95ebd129..HEAD`).

**Rubric used.** This repo has no `gates/configs/eval-rubric.yml`, and there is no `specs/20261117-legal-entities/eval.md`.
The synced WellForge plugin (`~/.claude/plugins/synced/…/wellforge/config/`) has no rubric file either. So I applied
**default-v2** exactly as every earlier report in `specs/*/eval-report.md` applies it (for example
`specs/20261116-letterhead-service/eval-report.md`):

| Dimension | Weight | Floor |
|---|---|---|
| AC satisfaction | 35 | 4 |
| Spec fidelity | 20 | 3 |
| Test quality | 20 | 3 |
| Code quality | 15 | 3 |
| Design fidelity (UI) | 15 | 3, applies when `design.md` exists |
| Trajectory | 10 | 2 |

`pass_score` is 80. `design.md` exists, so design fidelity applies and the total is normalised over 115.

**Verification evidence.**
- **QE (T45): PASS, 52/52 ACs.** It ran at `95ebd129` plus four test-only fixes (qe-report.md:3, :10-31, §11). That
  equals HEAD's product code, so the QE verdict is fresh. No product defects were open. D2 and D3, found by QE's e2e
  runs, were fixed before the final run.
- **OWASP:** the first review (T46) was REVIEW REQUIRED, with 1 medium (F1) (security-review.md:7). The re-review
  (T70) was PASS WITH NOTES: 0 medium or higher, lows N1 and N2 (security-review-2.md:7-15). Both reviews were static
  only. **T70 reviewed up to `815d58eb`.** After that, three product-code commits landed: `fcaedf07` (T76, the N2 fix),
  `c63a0681` (D2), and `95ebd129` (D3: a rewrite of the confirmation flow in `LegalEntityForm.tsx`, +270/−159 across
  9 files). None was re-reviewed. QE's reason for "not needed again" was "I changed no product code"
  (qe-report.md:391), and that reason does not cover these three commits.
- **What I re-ran at HEAD** (from a `git archive` copy in my scratchpad, with offline installs):
  - admin-ui `vitest`: **1100/1100** (61 files), plus `tsc -b` and `eslint` clean
  - crm-ui: **1691/1691**
  - letterheads-ui: **539/539**
  - operai-ui: **298/298**

  All four match the QE counts (qe-report.md:61-64).
- **What I did not run.** auth (1401), crm-api (2275), notify-api (637), the cargo workspace (707 + 38 + 2) and the
  e2e all need the database. The permission system refused to let me create a fresh database on the compose Postgres,
  so for these I rely on QE's recorded runs (qe-report.md §3, §5).
- **CI.** The branch is pushed. The last CI runs are at `fcaedf07` (T76), before D2, D3 and T44:
  - `letterhead-api`: green.
  - `changeset-check`: red. The cause is a dispatch-baseline artefact: `HEAD~1` was used as the base, and the
    changeset came later in `87a24dee`.
  - `env-doctor`: red, on the pre-existing `push.test.ts` failure, which is also red on `origin/main` (qe-report.md:21).

  No workflow has run at HEAD.

| Dimension | Weight | Score (/5) | Floor | Weighted | Evidence |
|---|---|---|---|---|---|
| AC satisfaction | 35 | **4** | 4 | 28.0 | **All 52 ACs have executed, passing evidence** (qe-report.md §9:236-289). The strongest checks:<br>• AC-2.6: 20 parallel saves gave 1×201 and 19×409 (:248).<br>• AC-2.7: raw `UPDATE`, `DELETE` and `TRUNCATE` each raise (:208).<br>• AC-5.5: a live registry outage gives 503 + `Retry-After` at +75 s (:211).<br>• AC-7.1–7.4: the MIG rehearsal ran in 5 rounds over 10 fixture cases, through the real copy role (§4).<br>• AC-9.7, 9.14, 9.15: notify-api down, retries, a +25 h give-up and `kill -9` durability (§6:163-168).<br>• AC-9.12: 0 hits for 27 forbidden values across every record and log, with a positive control (:170).<br>• AC-9.8: recipients are computed inside the version's transaction (`auth/src/legalEntities/notices/recipients.ts:34-67`, `write.routes.ts:254-271`).<br>• AC-9.1/9.3 after D3: Confirm sends the very body that was checked (`admin-ui/src/components/LegalEntityForm.tsx:382, :397-400`).<br>**Not 5:**<br>(1) The production halves of AC-3.2, AC-7.1–7.5 and AC-9.10 depend on owner steps T15–T18, T48, T49 and T71. They are rehearsed on compose, and I count them as unverified, not unmet (same standard as the 20261116 eval).<br>(2) AC-9.13's push leg was never rehearsed end to end. The only evidence is notify-api's idempotency test, which does not involve auth's notice (qe-report.md:173-175).<br>(3) AC-9.15's "no recipient at all" entry is unit-level only (:176).<br>(4) **O-1/N1:** AC-9.11 is met to the letter ("the person's name, as the history shows it"). But QE showed live that a session holder can rename themselves through `POST /auth/update-user` (qe-report.md:367-373). That weakens the purpose US-9 states (spec.md:206-210). The owner decision is open by design, so I do not count it as an unmet AC. |
| Spec fidelity / no drift | 20 | **4** | 3 | 16.0 | **Spec changes are well governed:**<br>• D1–D8 are dated owner decisions (spec.md:94-195).<br>• US-9 is owner-approved, "Nothing in US-9 is left unconfirmed" (spec.md:19-23), with OQ-1–13 resolved.<br>• Plan amendment G was approved by the owner (`c9e2b788`, plan.md:841).<br>• The superseded letterhead ACs are marked in specs/20261116 (T14).<br>• Unrequested scope is listed and accepted (tasks.md:616-621).<br>• Orchestrator decisions taken unattended are recorded "for review" (DR-14, DR-17 at tasks.md:1109-1113; the ConfirmDialog busy state at :1120-1123).<br>**Drift that is not recorded where it belongs:**<br>(a) **ADR candidates 5–8 of the security amendment were never written** (plan.md:1290-1301; `git diff --stat origin/main...HEAD -- docs/adr` shows only the 4 first-round ADRs). Candidate 5 itself says the durable notice outbox "departs from ADR 20260716 §4". That ADR says "Best-effort, not transactional … no retry-until-success" (`docs/adr/20260716-system-notifications-cross-user-trigger.md:59, :196`). Candidate 5 also amends ADR 20261105, and candidate 6 amends ADR 20260714 and ADR 20261101. None of these ADRs was amended, and AGENTS.md gained lines only for ADR-1 to ADR-4. Only FU-5 (candidate 8) is tracked as routed (qe-report.md:310).<br>(b) **plan.md is not synced to T76.** The built rule is: a pin lower than or equal to the held version gets 409 with no call; a forced refresh only for a newer pin; a per-process budget per 10 minutes (`fcaedf07`, tasks.md:762-769). plan.md G10 still describes F6 as 1/s coalescing only (plan.md:1155-1157), and ADR-2 §3 does not mention the budget or crm-api's 1.1 s wait (`docs/adr/20261117-the-letterhead-service-reads-…md:26`).<br>(c) design.md S12 still says "both buttons `aria-disabled`" while busy (design.md:382, :693). The build disables Confirm natively. This is accepted in tasks.md:1120-1123, but the design was not amended |
| Test quality | 20 | **4** | 3 | 16.0 | **Behavioural, and many tests have built-in controls:**<br>• the AC-9.12 sentinel scan has a positive control;<br>• the clock-injected cache tests check 29/31/59/61 s plus a sent-time property test (T21, T25);<br>• the golden comparison was captured *before* the switch (`78d2be25` precedes `3dcc97fe`);<br>• rule boundaries are tested at 200/201, 120/121, NBSP, U+3000 and lone surrogates (T2);<br>• the dispatcher is tested with two instances, a lease and a timeout-then-idempotent case (T59);<br>• six skew pairings were run live (qe-report.md §7);<br>• the D3 regression test asserts there is no nested `<form>` and drives a real `requestSubmit` (`LegalEntityForm.protected.test.tsx:571-595`).<br>**Against:**<br>(1) **D3, a high defect, passed the unit layer.** Confirm in the protected-change dialog did not save at all (a native nested-form navigation). Yet T60's done-when "Confirm → one save request" was ticked green. Only the T68 e2e caught it (tasks.md:779-790). D2 likewise surfaced only in e2e.<br>(2) Four test-code defects appeared only on a fresh stack. They were order and state dependencies between specs (qe-report.md §11:350-357).<br>(3) No mutation evidence for the rule core (`rules.ts`, `ibanTail.ts`, `protectedChanged`).<br>(4) The AC-7.x suite `import.test.ts` runs only with `CRM_TEST_DATABASE_URL` set (qe-report.md:15), and the committed-transaction groups run only on a local host, so a plain run is quieter than it looks.<br>(5) FU-12: the letterhead-api server-spawning helpers exhaust `max_connections` under parallel load (qe-report.md:328-346). This is still open.<br>(6) No CI at HEAD (see above).<br>(7) AC-9.13 push and AC-6.3's e2e are indirect: the e2e reaches an incomplete entity through a direct DB insert (tasks.md:1129-1131) |
| Code quality & conventions | 15 | **4** | 3 | 12.0 | **Clean and idiomatic.**<br>• One serializer serves both the person route and the service route.<br>• Refusal bodies are frozen and never echo input.<br>• The save writes the version, audit and notice rows in one transaction under an advisory lock (`write.routes.ts:228-299`).<br>• The post-commit kick cannot reach the answer (`:380-386`).<br>• Recipients are documented and de-duplicated (`notices/recipients.ts:1-67`).<br>• `Retry-After` is exposed over CORS.<br>• The `@operai/ui` lifts have no app strings.<br>• Changesets are present for all 9 packages.<br>• `tsc`, eslint and clippy `-D warnings` are clean (qe-report.md:59-65, and my own re-run of admin-ui).<br>• The security re-review found no authorization bypass, injection or value leak (security-review-2.md:7, :77-91).<br>**Against:**<br>• **N1 open** (actor display name editable: a weak point in the one control US-9 relies on).<br>• N3 (the host guard trusts `localhost`, so a tunnel passes).<br>• N5 (env-doctor does not check the deployed write limit).<br>• N6 (`requireAdmin` ignores `deletedAt`).<br>• O-2: a raw zod message reaches a person during the push-2 window (qe-report.md:374-379).<br>• FU-12 sits in test helpers.<br>• The rate limiters work per replica |
| Design fidelity (UI) | 15 | **4** | 3 | 12.0 | **design.md is complete and the build realises it:**<br>• flows F1–F18, states S1–S12 and N1 with every loading, empty, error, 403, 429 and paging state, an a11y plan (design.md:661-699), and a reuse / LIFT / NEW inventory mapped to `@operai/ui` (:445-516);<br>• QE confirmed every designed state in a browser and checked the inventory against the code: no NEW component where reuse was specified, and `ErrorSummary` and `VersionTable` are imported from the library (qe-report.md:213-228);<br>• axe 0 on every screen and on both dialogs, 320 px with no horizontal scroll, contrast ≥ 5.01:1 in both themes.<br>**Not 5:**<br>• design.md is still `status: draft` (:3).<br>• Its "Open items" are stale: done items are left unticked (DR-12, the lift, the plan DRs), and two items are genuinely open, the owner's review of T51's copy and DR-14 (:762-768).<br>• The S12 busy state deviates from the design and the design was not amended (see Spec fidelity (c)).<br>• FU-5 (the ADR for how a layout draws the missing mark) has not been written.<br>• The mockups were "not opened in a browser" (:17) |
| Trajectory | 10 | **2** | 2 | 4.0 | **No `wellforge-run/v1` trace exists for this feature** in `.forge/runs/` of any worktree (grep for `legal`/`20261117` returns nothing; the last trace is `2026-11-17T05-50-00Z-orchestrate-20261116-letterhead-service.json`). Per the rubric this gets the neutral floor.<br>**Git shows good habits:**<br>• every commit carries its task id;<br>• re-sync notes and touch-list widenings are recorded ("added 2026-11-17 (T58 report)");<br>• findings are routed to new tasks (T51–T76, D2, D3);<br>• QE ran *after* the last code change, unlike in 20261116.<br>**Git also shows deductions that would block a score above 2 even with a trace:**<br>(1) **T44 was ticked (`5640de49`) before its declared dependency T16**, contradicting its own note "this task follows it in the same release session; the dep on T16 stays" (tasks.md:492-499).<br>(2) **No OWASP pass after T70**, although T76 (the N2 fix itself) and D3 (the security control of F1/US-9) changed product code afterwards.<br>(3) T60 was ticked with a done-when ("Confirm → one save request") that was false in the browser until D3 |
| **Total** | 115 | | | **88.0 / 115 = 76.5/100** | |

**Verdict: FAIL.** The total of 76.5 is below `pass_score` 80. No dimension is below its floor: AC satisfaction (4/4)
and trajectory (2/2) are exactly at their floors.

## Owner-pending items: how this eval treats them

These items are open by design and are **not** counted as unmet:
- N1/O-1 (actor display name);
- the release steps T15–T18, T48 and T49;
- T71 (outside mailbox, granting managers).

The ACs whose production half depends on those steps (AC-3.2, AC-7.1–7.5, AC-9.10) have compose rehearsals. They cap
AC satisfaction at 4 and do not pull it lower.

Two consequences:
- If the production copy (T18) reports `mismatched` above 0, or an unaccepted `ibanPrintChanged`, AC-7.5 is unmet and
  a re-eval FAILs on the floor.
- O-1 must be decided before T71 (qe-report.md:372). If the owner chooses "add the actor's email", that is an AC-9.11
  change for the PO.

## Findings and who owns them

No dimension is under its floor. The total fails because everything sits at 4 and trajectory is held at 2 by the
missing trace. 80/100 needs 92/115, which is 4 weighted points more than now.

- **Trajectory: 2.**
  - **Owner:** orchestrator.
  - **Fix:**
    - Write the feature's `wellforge-run/v1` trace from the real history (agents, order, QE and OWASP verdicts, the
      D1–D3 drift events, the unattended orchestrator decisions). Do not reconstruct it as one clean pass.
    - Untick T44 or record why it ran before T16.
    - Run an OWASP delta over `fcaedf07`, `c63a0681` and `95ebd129`.
  - **Effect:** with these done, trajectory 4 is reachable (+4 → 92/115 = 80.0, PASS with zero margin).
- **Spec fidelity: 4.**
  - **Owner:** architect.
  - **Fix:**
    - Write ADRs 5–7: the durable notice outbox, which amends ADR 20261105 and departs from ADR 20260716 §4; notify-api
      idempotency and template binding, which amends ADR 20260714 and ADR 20261101; and the read-only check behind the
      confirmation.
    - Write ADR 8 (FU-5).
    - Add AGENTS.md lines for these ADRs.
    - Sync plan.md G10 and ADR-2 §3 to T76 (pin ≤ held → 409, the refresh budget, crm-api's 1.1 s wait).
- **Design fidelity: 4.**
  - **Owner:** designer, plus the owner for the copy review.
  - **Fix:**
    - Amend S12 and the a11y line (design.md:382, :693) to "Confirm disabled while busy".
    - Tick or close the stale Open items, and set the design's status.
    - Get the owner's review of T51's copy and the DR-14 decision.
- **Test quality: 4.**
  - **Owner:** dev and QE, plus devops.
  - **Fix:**
    - Get CI green at HEAD. Re-dispatch `changeset-check` with a proper base.
    - Run a mutation pass (Stryker) on `rules.ts`, `ibanTail.ts`, `protectedChanged` and `notices/content.ts`.
    - Fix FU-12: a semaphore in the spawn helpers, or `max_connections`.
    - Add a push-leg check for AC-9.13 that goes through auth's notice.
- **Code quality: 4.**
  - **Owner:** owner (decision), then backend-dev.
  - **Fix:**
    - Close N1. Either set `disabledPaths: ["/update-user"]` with a test, or add the actor's email to the notice.
    - Optionally close N5 (env-doctor checks the deployed `LEGAL_ENTITY_WRITE_RATE_LIMIT`) and add O-2's runbook line.

Not credited: commit-message self-descriptions; QE's "owasp not needed again", which reasons only about QE's own
changes.

## Recommended next step

FAIL. Do not move the spec to `done`. Route as follows:
1. **Orchestrator:**
   - write the run trace;
   - fix T44's checkbox;
   - schedule an OWASP delta (`owasp-reviewer`) on T76, D2 and D3.
2. **`/wellforge:implement 20261117-legal-entities`:**
   - architect: ADRs 5–8 and the plan/ADR-2 sync for T76;
   - designer: the S12 sync and design.md's status and open items;
   - devops: CI re-run at HEAD.
3. **Owner:** N1/O-1 before T71; the T51 copy review; DR-14.
4. Re-run `/wellforge:eval`. With trajectory at 4 and spec fidelity or design fidelity at 5, the total is 96/115 =
   83.5.
