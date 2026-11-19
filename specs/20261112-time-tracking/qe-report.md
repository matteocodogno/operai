# QE report — specs/20261112-time-tracking (rigor: production, full mode)

Three passes, newest first. **Third pass (2026-11-19, re-run of the blocked whole-suite row only, re-decided the same day under T35's amended done-when): this section, the current verdict.**
The second pass (BLOCKED) and the first pass (FAIL; D-1, D-2, D-3) are kept below, unchanged, as history.

## QE verdict: PASS   (third pass, re-decided 2026-11-19 under T35's amended done-when, `b891e73f`; e2e measured at 8756952a; every other row carried from the second pass: `git diff --stat 3ca1931f HEAD` is 4 files, the run trace, `shell/e2e/hours.spec.ts` (my test), this file and `tasks.md`; 0 application files)

**Re-decision, 2026-11-19 (no new test run; the evidence below is unchanged).** As first written (`fbb298d1`) this pass was BLOCKED. Two facts changed the same
day, both relayed to me by the main loop (I did not hear them from the user directly):

1. **The user accepted every failure outside hours as independent of this branch**: P-2 and P-2b, P-3, Q-1 and Q-2, on the evidence recorded below.
2. **T35's done-when was amended** (`tasks.md`, commit `b891e73f`, which I re-read): `hours.spec.ts` passes with the stack up; the whole `pnpm e2e` runs on a stack whose
   crm-api has the letterhead service off, with every failure outside hours shown independent of the branch and named in this file with its evidence;
   `crm-offer-wizard-service.spec.ts`, which needs the opposite crm-api mode, is **outside this feature's gate**. The earlier wording ("the whole `pnpm e2e` still passes")
   could not be met on one stack.

Under the amended done-when every row holds, so the verdict is **PASS**. I record the acceptance as the user's, not as my verification, and I keep the two levels
of proof apart. **P-2, P-2b, P-3: shown independent**: the specs, fixtures, services and remotes they exercise are byte-identical to the merge base `512851c2`
(empty `git diff`), with a mechanism and a control for each. **Q-1, Q-2: accepted, not proven by me.** The test files, notify-ui, crm-ui and `operai-ui/src/styles`
are byte-identical, but the shell build they run in carries the branch's additive hours changes (the "My hours" link, one trusted origin, one Tailwind
`@source` line, the hours remote entry), their cause is unknown and I have no main baseline. The PASS depends on that acceptance for those two.

The three environment faults of the second pass are **repaired, and verified by their specs now passing**: EF-9 (push-notifications 6 of 6), EF-2
(crm-offer-wizard 9 of 9), EF-10 (meetings-deal 3 of 3). Every hours journey is green: 12 of 12 in the targeted re-run and in each of two
whole-suite runs. **No defect in this branch, and on the evidence nothing red is attributable to it** (for Q-1 and Q-2 see the re-decision note: accepted, not proven).

Why it was BLOCKED as first written, kept for the record. The brief's premise, "green except P-1 and P-2", does not hold. Two whole `pnpm e2e` runs
on the repaired stack ended **158 passed / 5 failed / 1 skipped / 20 not run (13.1 min)** and **156 / 5 / 1 / 22 (12.9 min)**. Beyond P-1 and P-2 the red set holds: P-3 (a test of another feature whose fixture cannot satisfy its own control), P-2's second placement
(`letterheads-access.spec.ts:126`, the same fixture race), two **intermittent** failures I could not explain (Q-1, Q-2), and a spec file that needs the
other stack mode (EF-12: 9 tests I could not execute). I did not write PASS on the user's behalf for those:
acceptance is theirs to give, as it was for P-2. The user has since given it (above).

### Checks not executed (named first)

| Check | Needs | What I did |
|---|---|---|
| `crm-offer-wizard-service.spec.ts`, 9 tests | crm-api with `LETTERHEAD_SERVICE_ENABLED=true`, `LETTERHEAD_API_URL=http://localhost:18240` (the relay the spec runs) and an `auth` `crm-api` client holding `letterhead:render`: a stack in the **other mode**. The three legacy offer-wizard specs need it **off** (the spec header says so: with it on they answer 410 `letterhead_upload_retired`) | ran it: 1 timed out, 8 not run. `GET /scope` on the running crm-api answers `letterheadService:false`, and crm-ui mounts `ServicePreview` (the `crm-wizard-service-preview` element the test waits for) only when it is `true` (`OfferWizard.tsx:176-178`). I did not reconfigure the shared crm-api: it is the main loop's, and its secrets are in files I am not to read. **Outside this feature's gate since `b891e73f`**: not executed, and not required |
| `crm-offer-wizard-revise.spec.ts:230` (AC-7.3) | an active classic English template on welld_ch | skipped by the spec's own precondition, with its named reason; not a failure |

Everything else ran.

## Verdict table (third pass)

| Check | Threshold | Actual | Result |
|---|---|---|---|
| EF-9 repaired: `push-notifications.spec.ts` | 6/6 | 6/6 (turn on and reload, removal from the list, removal from another session, on-load offer ×2, signed-out deep link) | ✓ |
| EF-2 repaired: `crm-offer-wizard.spec.ts` | 9/9 | 9/9 in two runs; 6/9 in one (Q-2: `:533` failed, `:588` and `:617` then not run) | ✓ (EF-2); Q-2 accepted by the user |
| EF-2: `crm-offer-wizard-revise.spec.ts` | all | 4 passed, 1 skipped by its own precondition (`:230`, AC-7.3: "welld_ch has no active classic English template to make a legacy offer from"; a spec-owned skip with a named reason) | ✓ (4); 1 spec-owned skip |
| EF-2: `crm-offer-wizard-pages.spec.ts` | 12/12 | 11/12: `:380` fails (P-3); the 10 tests the serial describe then does not run were run by me without `:380` (`--grep-invert`): **11 of 11 pass** | ✓ (`:380` is P-3, accepted by the user 2026-11-19) |
| `crm-offer-wizard-service.spec.ts` | outside the gate (`b891e73f`) | 0/9, not executed: the stack is in the legacy mode (EF-12) | n/a (outside the gate) |
| EF-10 repaired: `meetings-deal.spec.ts` | 3/3 | 3/3 (record, stop, `ready` in 23 s; link a meeting; the access journey); every `meetings-*` test also passed in both whole runs | ✓ |
| `hours.spec.ts` + `hours-owners.spec.ts`, once after the restart | 12/12 | 12/12 (5 + 7, 54 s); 12/12 again in each of the two whole runs | ✓ |
| Whole `pnpm e2e` (T35 as amended), run A (08:29) | legacy-mode stack; every failure outside hours named with its evidence and accepted as independent | 158 passed / 5 failed / 1 skipped / 20 not run of 184; the 5: `crm-offer-wizard-pages:380`, `crm-offer-wizard-service:200`, `letterheads-access:126`, `letterheads:379`, `notifications:426` | ✓ (P-3, EF-12 outside the gate, P-2, P-2b, Q-1 accepted by the user 2026-11-19) |
| Whole `pnpm e2e` (T35 as amended), run B (08:53) | same | 156 / 5 / 1 / 22 of 184; the 5: `pages:380`, `service:200`, `crm-offer-wizard:533`, `letterheads-access:126`, `letterheads:379` | ✓ (Q-2, P-2b, P-2, P-3, EF-12 as above) |
| T35 as amended: `hours.spec.ts` passes with the stack up | 5/5 | 5/5 (with `hours-owners.spec.ts` 7/7), in the targeted re-run and in both whole runs | ✓ |
| T35 as amended: the whole e2e ran on a stack whose crm-api has the letterhead service off | `letterheadService:false` | `GET /scope` → `letterheadService:false`; the three legacy offer-wizard specs ran in their intended mode (wizard 9/9, revise 4 + 1 skip, pages 11/12) | ✓ |
| All other rows of the second pass (gates, coverage, D-1/D-2/D-3, AC 44/44, a11y, design) | as before | **carried**: nothing but my e2e test and docs changed since 3ca1931f | ✓ (carried) |

Run command, both whole runs and the targeted ones: the ten `E2E_*_REMOTE_PORT` variables of the earlier passes, `pnpm exec playwright test --reporter=list,json --trace off`.
Evidence, in `/private/tmp/claude-331608204/-Users-edoardo-paronzini-Work-Experiments-operai/f2ce1f1a-3ebd-4e72-83ca-8155e69a4eef/scratchpad/` (below `SP/`):
`e2e-rerun3.log|json` (the blocked specs), `e2e-pages-rest.log`, `e2e-hours3.log`, `e2e-full3.log|json` (run A), `e2e-full4.log|json` (run B).

Accounting of the 42 tests the second pass called blocked (4 + 31 crm-offer-wizard, 5 push, 2 meetings-deal), plus the two other crm-offer-wizard tests:
44 tests of the three groups = **33 passed, 2 failed (`pages:380`, `service:200`), 1 self-skipped (`revise:230`), 8 not run (the rest of the service spec)**.

## The red set, one by one (all outside hours; each named with its evidence, as T35 now requires)

The branch's diff against the merge base (`512851c2`) holds no file of crm-api's offers or entity profiles, crm-ui, letterhead-api, letterheads-ui, nor any of
the specs and fixtures named here (`git diff --stat 512851c2 HEAD -- crm-ui crm-api/src/offers crm-api/src/entity-profiles shell/e2e/crm-offer-wizard*.spec.ts
shell/e2e/helpers/crmOfferFixtures.ts shell/e2e/fixtures/letterhead-a4.pdf shell/e2e/letterheads*.spec.ts shell/e2e/fixtures/letterheads.ts` is empty). Q-1 and Q-2 also run in
the shell, which the branch changes additively (see the re-decision note).

| # | Test | Cause | Evidence | Status |
|---|---|---|---|---|
| P-1 | env-doctor `push.test.ts` | fails on `origin/main` | second pass, not re-run (the diff touches neither file) | pre-existing, carried |
| P-2 | `letterheads.spec.ts:379` | `recordPreviewCalls` keeps `request.response()` of every preview request; the test closes its context while the (debug-build) service still draws the preview, and the promise rejects unhandled | second pass: mechanism proven (a temp copy awaiting the response passes); **accepted by the user 2026-11-19 as pre-existing**, spec fix a separate bugfix | accepted |
| P-2b | `letterheads-access.spec.ts:126` (then `:202`, `:264` not run: serial) | **the same fixture, the same line** (`fixtures/letterheads.ts:327`, `request.response: Target page, context or browser has been closed`). Failed in both whole runs; it passed in the second pass, where it simply finished after the preview | placements of `recordPreviewCalls`, five tests: `letterheads.spec` `:75` ✓ `:129` ✓ `:270` ✓ `:379` ✗, `letterheads-access` `:126` ✗ (the other tests of those files do not use it) | same class as P-2; **accepted by the user 2026-11-19** |
| P-3 | `crm-offer-wizard-pages.spec.ts:380` | the test's last assertion is a **control**: with the cover over the page number hidden, the letterhead's own number must show (> 20 pixels of ink in the corner). `ensureLetterhead` uploads `fixtures/letterhead-a4.pdf` only when the entity has none and "never replaces an existing one (the owner's real one on a dev stack)"; that PDF has **no page number** (its content stream: a band, a title, a rule, one footer line at the left). On this dev DB welld_ch's letterhead is that fixture, byte-identical (sha256 `48c3e296…7191`, uploaded 2026-11-16 by the e2e persona). So the control reads 0, always | `SP/p2/stored-letterhead.pdf` equals the fixture; **as stored: 0 of 3 pass** (`Received: 0` ×3, `SP/p2/pages380-fixture-letterhead.log`); **the same letterhead with "1/1" added in the corner** (`SP/p2/letterhead-numbered.pdf`, made by `SP/p2/make-numbered.ts`, served to the browser by a route in a temporary copy of the spec, removed): **3 of 3 pass** (`SP/p2/pages380-numbered-letterhead.log`). So the cover logic works; the fixture cannot satisfy the control. The spec, the PDF and `ensureLetterhead` are identical on `origin/main` (`cc2c3f46`): main's later edits of `crmOfferFixtures.ts` are the legal-entity registry | pre-existing spec/fixture defect (passes only on a stack whose welld_ch letterhead carries its own number); **accepted by the user 2026-11-19** |
| EF-12 | `crm-offer-wizard-service.spec.ts` (9) | stack mode, see "could not run" | `GET /scope` → `letterheadService:false`; the test times out waiting for `crm-wizard-service-preview` | environment, needs the other mode; **outside this feature's gate** (T35 amended, `b891e73f`) |
| Q-1 | `notifications.spec.ts:426` (sign out A, sign in B) | **not established**. Run A only: `page.goto('/notify')` "is interrupted by another navigation to `…/sign-in?redirect=…`" after 1.5 s. Passed in the first and second passes and in run B | **0 failures in 76 isolated executions**: the file ×3 (`SP/e2e-notif-run1..3.log`), the test ×25 (`SP/e2e-notif-repeat.log`), ×25 with every core busy (`SP/e2e-notif-repeat-load.log`), ×3 with a 1.5 s sign-out answer (`SP/e2e-notif-slow-signout.log`), and delays of 150, 250, 350, 500, 700 ms ×4 each (`SP/e2e-notif-slow-*.log`). My race hypothesis (the old document's sign-out redirect landing during the new `goto`) did **not** reproduce, so I do not claim it. The test file, the shell sign-out path and notify-ui are untouched; the branch's shell diff there is additive (`session.ts`: one more trusted origin; `UserMenu.tsx`: one link) | intermittent, cause unknown; **accepted by the user 2026-11-19**; independence not proven by me |
| Q-2 | `crm-offer-wizard.spec.ts:533` (dark theme, "the paper looks the same in both themes"), then `:588`, `:617` not run | **not established**. Run B only; passed in the targeted run and run A. In isolation it is **flaky at about 3 in 10**: 3/10 (`SP/e2e-wizard-dark-repeat.log`), 3/12 in a temporary copy that saves both screenshots (`SP/p3/dark-repeat.log`, `SP/p3/*.png`), the whole file 6 of 9 once | in the three saved pairs the two screenshots have the same size and the same paper and letterhead; **2,650 to 9,235 pixels differ, all in the offer's text area** (x 60 to 464, y 107 to 314). My hypothesis, text layout not yet settled when the screenshot is taken, is **refuted**: with the pages spec's own settle wait added, still 3 of 20 fail (`SP/p3/dark-settled-repeat.log`). crm-ui and `operai-ui/src/styles` are byte-identical to the merge base; the branch's only shell-CSS change is one Tailwind `@source` line for hours-ui. I have no baseline on a main-built shell (that reproduction was withdrawn, below) | intermittent, cause unknown; **accepted by the user 2026-11-19**; independence not proven by me (no main baseline) |

**On the main-worktree reproduction of P-2 (step 3 of the brief).** It was withdrawn at the user's request after I had already run it. I stopped, the scratch
worktree is removed and pruned (`git worktree list` shows only the main checkout), and **P-2 rests on the second pass's mechanism evidence and the user's
acceptance**, as asked. For completeness, what that run had shown, supplementary only: a scratch worktree of the merge base (`512851c2`; `origin/main` has
since moved 15 commits, with a changed letterheads spec and backends the running stack does not have, so it could not be paired with this stack), its own
Playwright config and fixtures, the running stack: `letterheads.spec:379` red 2 of 2 and `letterheads-access:126` red 5 of 5, both at `fixtures/letterheads.ts:327`
(`SP/p2/wt-unfixed-*.log`). `origin/main` already carries the fix for that very function (commit `a07f57da`, a `.catch` with a comment that
says the Italian journey "failed 6 of 6 runs on a fresh stack for this alone"); applying only that function in the scratch worktree: 379 green 3 of 3,
`access:126` green 5 of 5, both files 12 of 12, every placement (`SP/p2/wt-fixed-*.log`, `SP/p2/main-fix-applied-in-worktree.diff`). So a rebase onto
`main` removes P-2 and P-2b without a change in PR #10. A main-built shell could not be served (the shell must sit on :5173, the only origin `auth` and
letterhead-api allow), so this is test-code evidence against this stack, not a full main run.

## Defects

None. Nothing in this pass is attributable to the time-tracking diff on the evidence, and the hours journeys (12 of 12, three times) did not fail once.

## Environment faults

EF-12 (above): outside this feature's gate. EF-2, EF-9, EF-10 of the second pass: **repaired, verified**. What I could not verify is whether Q-1 and Q-2 are the environment (a loaded
machine) or the tests; the repeats under load did not reproduce them.

## Spec bug (drift rule): resolved

T35's done-when ("the whole `pnpm e2e` still passes") could not be met on one stack as written: `crm-offer-wizard-service.spec.ts` needs `LETTERHEAD_SERVICE_ENABLED=true`
and the three legacy offer-wizard specs need it off, by their own headers. The main loop amended it (`tasks.md`, `b891e73f`) to a wording that can be satisfied
(legacy-mode stack, failures outside hours named with evidence, the service spec outside the gate); I read it and judge this pass against it.

## Observations (not defects)

- `origin/main` is 15 commits ahead of this branch's merge base (legal-entity registry, letterheads, Inter font). **20 files changed on both sides** (among them
  `AGENTS.md`, `auth/src/authz/seed.ts`, `auth/src/system/serviceClients.ts`, `mise.toml`, `shell/playwright.config.ts`, `shell/src/strings.ts`, `operai-ui/src/index.ts`,
  `tools/env-doctor/manifest.ts`). Every number in this report is for the branch as it stands; after a rebase the gates and the whole suite need a re-run.
- Every e2e run adds permanent rows (retired categories, letterhead versions, offer numbers, `@operai.test` users). I created no new persona. I ran `git fetch` once (remote-tracking refs only) to see how far `origin/main` had moved.
- `design.md`, a11y and component-reuse rows: unchanged since the second pass.

## Tests I added

None in this pass (the fifth hours journey is the second pass's, commit 57814131). Temporary spec copies (P-3's numbered letterhead, Q-1's slow sign-out,
Q-2's screenshots) were removed; `git status` shows only this file.

## Security

No new surface. No `owasp-reviewer` pass needed for this round.

## Next

1. T40 (close) still needs the eval, which is not mine. The QE row of T40 is PASS.
2. After a rebase onto `main` (see Observations) the gates and the whole suite need a re-run; `main` already fixes P-2 and P-2b (`a07f57da`).

---

# SECOND PASS (history, superseded by the third pass above)

The first pass (FAIL, D-1, D-2, D-3) is kept unchanged below the line, as history.

> **Main-loop note, 2026-11-19 (not a QE pass).** P-2 (`letterheads.spec.ts:379`) accepted by the user as pre-existing:
> recorded here with the QE's evidence, its spec fix is a separate bugfix after this PR, PR #10's scope unchanged. EF-9 repaired
> by the main loop (notify-api `prisma generate`, restarted). EF-2 and EF-10 stay open on this machine (crm-api
> `ACTIVITIES_API_URL`; ffmpeg and meetings-api service-client credentials). PR #10 is marked ready for review at the
> user's request while this verdict stays BLOCKED: the feature is NOT closed (no eval, T35 and T40 open). Closing needs
> EF-2/EF-10 repaired and a QE re-run of the blocked specs (crm-offer-wizard*, push-notifications, meetings-deal).

## QE verdict: BLOCKED   (second pass; gates measured at 3ca1931f; my two commits add `shell/e2e/hours.spec.ts` (57814131) and this file, nothing a gate measures)

D-1, D-2 and D-3 are **fixed, in every placement, rendered**; nothing in this pass is a ✗ and no hours spec failed (11 of 11 existing
hours journeys green, plus 1 I added). The row that keeps the verdict from being PASS is T35's "whole `pnpm e2e` green": it ran,
**140 passed, 12 failed, 31 did not run** (was 108 / 23 / 51), and every one of the 43 non-passes has an established cause outside
this branch: three environment faults (EF-2 still open, EF-9 and EF-10 new) and one pre-existing test race on `main` (Pre-existing P-2).
Nothing here asks a dev agent for a fix round. The caller repairs EF-2, EF-9, EF-10 and re-runs the blocked specs (commands below).

### Checks I could not run to green (named first)

| Check | Needs | What I did |
|---|---|---|
| `cd shell && pnpm e2e`, whole suite (T35 done-when) | crm-api with `ACTIVITIES_API_URL` in effect (EF-2); notify-api with a regenerated Prisma client (EF-9); `ffmpeg`/`ffprobe` on meetings-api's PATH (EF-10) | ran it whole (13.9 min, recipe of the first pass): 140 / 12 / 31, cause of each in "Whole-suite e2e" below. The blocked specs are 4 + 31 (crm-offer-wizard), 5 (push-notifications), 2 (meetings-deal) |
| betterleaks (the CI secret scanner) | the `betterleaks` binary, not installed | `gitleaks 8.30.1` with `.betterleaksignore` over the 11 commits since the first pass: 0 findings. Substitute, as in the first pass |

Everything else ran.

## Verdict table (second pass)

| Check | Threshold | Actual | Result |
|---|---|---|---|
| D-1 Everyone's hours: ~40 filter changes (3 reads each) in 10 min, API, paced 15 s, a holder | every person named, `identities` never in `unavailable` | 40 changes, 120 reads, 2909 list rows checked: 0 degraded. Auth budget left afterwards 93 of 120 (hours-api spent 27; first pass: 120 spent by about change 40, names lost from there) | ✓ |
| D-1 same through the real UI (headless browser, holder persona): 40 changes in 622 s, plus 120 My hours filter actions in parallel | no "Unknown user", no "names could not be loaded" banner | 0 of 160 actions degraded; 115 of 120 budget left, measured 2.5 min after the run (so the oldest 2.5 min of calls had left the window) | ✓ |
| D-1 My hours, API: 120 actions 5 s apart, every fourth after a `POST`, one `PATCH` in twelve | named | 120 reads, 30 `POST` + 10 `PATCH` views: 0 degraded; 119 of 120 left (she shares names with the holder's cache: cross-viewer reuse, as the plan says) | ✓ |
| D-1 My hours placements through the UI (310 entries): load, 2 reloads, Load more, 10 filter changes, Save ×3, Edit ×3, Delete ×3, Export ×2 | named, no banner, export names present | 26 actions in 99 s: 0 degraded; 117 of 120 left | ✓ |
| D-1 Everyone's export walk | names in the file | 1272 rows, 8 people, 0 unknown/empty names; Hours numeric `0.0`; file sum 3131.5 h = the screen's "3,131 h 30" | ✓ |
| D-1 `groupBy` day, project, deal, category, month, Settings: 0 lookups | unchanged | no code path of the diff calls `resolveIdentities` for them (`totals`/`labels` changed in comments and tests only); not re-measured | ✓ (carried) |
| AC-4.8: a rename shows within 60 s (live) | old name for at most 60 s from the cached send, then the new name | renamed through auth; hours-api served the old name for 55 s after the rename (the cached batch was sent about 5 s before it), then the new one | ✓ |
| D-2 five design strings + the From/To pair, en and it, My hours and Everyone's hours | the design.md § Date rules — copy table, word for word | all rendered as designed, see table below | ✓ |
| D-3 the six `TimeListItemDialog` placements, en and it | × "Close"/"Chiudi", footer "Cancel"/"Annulla", one of each | 6 of 6 in en and 6 of 6 in it; the entry dialog still ✓ | ✓ |
| Whole `pnpm e2e` (T35 done-when) | all green | 140 passed / 12 failed / 31 not run; 0 in hours; causes below | BLOCKED |
| T35 `hours.spec.ts`, T36 `hours-owners.spec.ts` | pass | whole-suite run: 4/4 and 7/7; after my fifth journey, re-run of both files: 12/12 (5 + 7) | ✓ |
| hours-api typecheck | exit 0 | exit 0 | ✓ |
| hours-api tests (`hours_test`) | all pass | 1871 pass, 0 fail, 45 files (first pass 1812 / 43) | ✓ |
| hours-api coverage | ≥ 80 % lines | 99.20 % lines, 98.94 % functions; `lib/identities.ts` 100 % / 100 % | ✓ |
| hours-ui lint, build | exit 0 | lint exit 0, build exit 0 | ✓ |
| hours-ui tests | all pass | 1523 pass, 57 files (first pass 1504) | ✓ |
| hours-ui coverage | ≥ 80 % lines | 98.73 % lines, 96.10 % branches, 95.68 % functions (shell's `@vitest/coverage-v8` linked in for the run, removed, `hours-ui/coverage` removed) | ✓ |
| `mise run shared:check`, `changeset:check`, `env:doctor`, `react:skew` | exit 0 | all 0 (`shared:check`: 33 groups in sync) | ✓ |
| tools/env-doctor `push.test.ts` | pass | not re-run: the diff touches neither file; stays recorded as the first pass did (fails on `origin/main` too) | ✓ (pre-existing, carried) |
| Mutation check of the name cache (a scratch `git worktree`, removed) | each mutant fails the unit files | TTL 0 fails the budget test (110 refusals, the first on the holder's 121st call at +360 s); keep every item, cache a failure, clock from arrival, never expire, keep an omitted id: each killed (1 to 12 failing tests) | ✓ |
| Dependency audit | no critical | not re-run: no `package.json` or lockfile in the diff since 309845fb; first pass stands (none critical) | ✓ (carried) |
| Secret scan (security floor) | 0 findings | 0 in the 11 commits since the first pass (gitleaks substitute) | ✓ |
| AC coverage (spec.md, 44 ACs) | 44/44 | 44/44 named by at least one test file that ran green in this pass or the first (hours-api, hours-ui, hours e2e); AC-4.8: api 5, ui 7 (first pass api 3) | ✓ |
| Exploratory regression sweep (My hours, entry dialog by keyboard, Everyone's, export, Settings) | no regression | all walked, 0 console or page errors, see below | ✓ |
| Design states, a11y, component reuse (design.md) | as the first pass | unchanged by the diff (copy and one label); duplicated-name class now ✓ | ✓ |

## D-1 — fixed (T46, 60 s cache keyed by user id)

Fix of the class, every placement of the first pass's table, measured live on the dev stack (hours-api restarted at 16:52 on the
T46 code, `bun run --hot`):

| Placement (first pass) | First pass | Now |
|---|---|---|
| My hours: load, filter change, Load more, Save, Edit, Delete | 1 lookup per action, 120 spent after ~120 actions | 26 UI actions: 3 spent. 120 API actions: 1 spent. Always named |
| Everyone's hours: load or any filter change | 3 lookups per change, 120 spent after ~40 changes | 40 changes (API and UI): 27 spent over 10 min (the plan's bound is ≤ 50), never degraded |
| Export walk | 1 per page | 1 page: names present in the file |
| `groupBy` day / project / deal / category / month, Settings | 0 | 0 (unchanged) |

Evidence: `holder.out`, `emp.out`, `ui.out`, `ui-d1b.out`, `rename.out` in
`/private/tmp/claude-331608204/-Users-edoardo-paronzini-Work-Experiments-operai/f2ce1f1a-3ebd-4e72-83ca-8155e69a4eef/scratchpad/d1/`
(scripts beside them). How the budget was measured: after each run I spent the persona's remaining identities budget by calling
`auth POST /authz/users/identities` directly until the first 429 (the budget is per `sub` and shared by every caller of that route).

The unit evidence is sound as well: `identities.budget.test.ts` fails with the cache off (the 120-per-10-min limiter, the same
numbers as my live measure of the first pass: the holder's first refusal on call 121), and five more mutants of `identities.ts` are
each killed. The cache is cross-viewer by design (plan § Sequences "Names"): in the employee's run it served names the holder's reads
had fetched, which is why she spent 1 call; the budget test keeps her apart on purpose.

## D-2 — fixed, rendered (headless Chromium through the shell, `<html lang>` en and it, `d2d3.out`, `d2b.out`)

| Placement | en | it | Result |
|---|---|---|---|
| Entry dialog, Day emptied (what a half-typed or impossible date leaves in the native field) | "Choose a valid day." | "Scegli un giorno valido." | ✓ ✓ |
| Entry dialog, Save with Day emptied and Duration filled | one alert, "Choose a valid day.", focus on Day | "Scegli un giorno valido.", focus on Day | ✓ ✓ |
| Entry dialog, Day 31.12.1999 | "The day cannot be before 01.01.2000." | "Il giorno non può precedere il 01.01.2000." | ✓ ✓ |
| Entry dialog, 30.02.2026 typed on the keyboard | Chromium rolls 02/30 to 2026-03-02 (a real day, no error: browser behavior) | field empty, "Scegli un giorno valido." | ✓ ✓ |
| My hours, Custom, From before the floor | "The start date cannot be before 01.01.2000." | "La data di inizio non può precedere il 01.01.2000." | ✓ ✓ |
| My hours, Custom, To before the floor | "The end date cannot be before 01.01.2000." | "La data di fine non può precedere il 01.01.2000." | ✓ ✓ |
| My hours, Custom, both before the floor | two different alerts, From then To (first pass: the same sentence twice) | same, in Italian | ✓ ✓ |
| Everyone's hours, Custom: From, To, both (same `HoursFilters`) | as My hours | as My hours | ✓ ✓ |

Screenshots (`/Users/edoardo.paronzini/Work/Experiments/operai/.playwright-mcp/`): `qe2-d2-my-en.png`, `qe2-d2-my-it.png`,
`qe2-d2-all-en.png`, `qe2-d2-all-it.png`. A six-digit year could not be typed in Chromium's field (it keeps four digits); that case
rests on the component tests. `d2d3.out` ends with 2 "BAD" lines: those are my script's own wrong expectation (Duration left empty, so
Duration's error shows next to Day's); `d2b.out` repeats the step with Duration filled and is clean.

## D-3 — fixed, rendered (`d2d3.out`)

All six placements of `TimeListItemDialog`, in English and Italian, each with one "Close"/"Chiudi" (the ×) and one
"Cancel"/"Annulla" (footer) and "Add"/"Aggiungi" or "Save"/"Salva": Add category ✓, Add project work type ✓, Add deal work type ✓,
Rename category ✓, Rename project work type ✓, Rename deal work type ✓. The × closes each. Entry dialog: "Close" + "Cancel" ✓.
Delete confirmation: focus on Cancel ✓. Screenshots: `qe2-sweep-settings-dialog.png` (the dialog with × and Cancel),
`qe2-d3-settings-en.png`, `qe2-d3-settings-it.png`.

## Whole-suite e2e (T35 done-when): 140 passed, 12 failed, 31 not run (13.9 min)

Run command: the first pass's recipe (the ten `E2E_*_REMOTE_PORT` variables, `pnpm exec playwright test --reporter=list,json`).
Results: `/private/tmp/claude-331608204/-Users-edoardo-paronzini-Work-Experiments-operai/f2ce1f1a-3ebd-4e72-83ca-8155e69a4eef/scratchpad/e2e-full2.json`
and `e2e-full2.log` (same directory). Hours: 11 of 11 green. First pass's EF-1, EF-4, EF-6, EF-7 are **repaired and verified by their
specs passing now**: inventory-assignment 3, inventory-ledger 1, letterheads-access 6, -browser-contract 2, -versions 5, letterheads 5 of 6,
activities-notify 1, refund-headline 2, -batches-headline 2, -settings 2, self-approval-control 1, mileage-rate 1. EF-3's missing table
is applied and EF-5's `PUSH_ENABLED` is on (notify-api now answers `enabled: true` to `GET /push/config`), but each has a deeper cause.

| # | Failing specs (failed + not run) | Cause, with the evidence | Branch code? | Repair (a person) |
|---|---|---|---|---|
| EF-2 (still open) | `crm-offer-wizard`, `-pages`, `-revise`, `-service` (4 + 31) | the fixture's `POST /deals/:id/estimate/override` → 503 `activities_unconfigured` ("Activities are not configured for the CRM"). `crm-api/src/lib/activities.ts:133` raises it when `baseUrl === undefined \|\| tokens === null`. The running crm-api (pid 48504, started 16:52:47) has `SERVICE_CLIENT_ID`, `NOTIFY_INTERNAL_URL`, `PROJECTS_INTERNAL_URL` in its environment and **no `ACTIVITIES_API_URL`**; `crm-api/.env.example:27` lists it. The branch's crm-api diff is `activity-host/resolve*` only | no | give crm-api `ACTIVITIES_API_URL=http://localhost:8087` (and the pair `SERVICE_CLIENT_ID`/`SECRET` it already has), restart crm-api |
| EF-9 (new) | `push-notifications` ×5 (the 6th, on-load no-subscription, passes) | `GET /push/devices` → 500 "Unexpected database failure listing push devices". The DB is fine (`push_device` exists, migration `20261111164143_add_push_device` applied). The **generated Prisma client of notify-api is stale**: `notify-api/src/lib/generated/prisma/models` holds `EmailDelivery.ts` and `Notification.ts`, no `PushDevice.ts`; the schema has `model PushDevice` (line 87). In a scratch worktree `prisma generate` from the same schema produces `PushDevice.ts`. Same class as the first pass's EF-7. Of the ten services notify-api is the only one whose schema/model counts differ (3 vs 2) | no | `cd notify-api && bun run db:generate`, restart notify-api (run outside `mise run dev`) |
| EF-10 (new; EF-3's table is fixed) | `meetings-deal` ×2 (1 passes) | a recorded meeting stays `processing`, the test waits 120 s for `ready`. `meeting_job` in the dev `meetings` DB: `prepare_audio` jobs `failed`, `lastErrorCode: media_unavailable`, 3 of 3 attempts, 4 of them in this run; `prepareAudio.ts:295` maps `ToolMissingError` ("binary could not be started", `media/probe.ts:54`) to that code. `ffmpeg` and `ffprobe` exist nowhere on this machine (`which`, `/opt/homebrew/bin`, `/usr/local/bin`). Also, as the caller predicted, `deliver_host_notice` jobs sit `queued` with `lastErrorCode: unavailable` (meetings-api has `SERVICE_AUDIENCE` but no `SERVICE_CLIENT_ID`); a likely second blocker for the deal journey once audio prepares, not proven independently | no | install `ffmpeg` (provides `ffprobe`) so meetings-api finds it; give meetings-api `SERVICE_CLIENT_ID`/`SECRET` (auth client `meetings-api`), restart |

Re-run only these, after the repairs (same ten `E2E_*` variables): `pnpm exec playwright test e2e/crm-offer-wizard*.spec.ts`,
`e2e/push-notifications.spec.ts`, `e2e/meetings-deal.spec.ts` (the 42 blocked tests: 4 failed + 31 not run in crm-offer-wizard, 5 failed in push, 2 failed in meetings-deal; the three groups of specs hold 44 tests, 2 of which already pass).

### Pre-existing, not this branch (listed so nobody chases them)

- P-1 (first pass, unchanged): `tools/env-doctor/push.test.ts` fails on `origin/main` too.
- P-2 (new, found because EF-4 no longer hides it): `letterheads.spec.ts:379` "the screen is in the person's language: Italian when
  the browser asks for it" fails, 2 of 2 (in the whole run and alone), `Error: request.response: Target page, context or browser has
  been closed` at `shell/e2e/fixtures/letterheads.ts:327`. Cause: `recordPreviewCalls` stores `request.response()` for every preview
  request; the test ends right after seeing the first request (`calls.length > 0`) and calls `context.close()` while that preview is
  still in flight, so the promise rejects unhandled. The dev letterhead-api is a **debug build** (`target/debug/letterhead-api`) and
  answers the preview in 935 to 973 ms (3 runs, `lh-timing.mjs`), so the request is always still open at the close. Proof of the
  mechanism: a temporary copy of the spec with `await calls[0]!.response` before `context.close()` passes (2.1 s); the copy is removed.
  The branch touches none of `letterhead-api`, `letterheads-ui`, `shell/e2e/letterheads*.ts`, `shell/e2e/fixtures/letterheads.ts`
  (`git diff origin/main...HEAD` is empty for them). Not reproduced on a `main` stack (the stack runs this branch's code), so the
  claim is "independent of the branch", proven by the mechanism, not "seen red on main". Owner: whoever owns the letterheads spec;
  a timing race that a release-built service (fast preview) hides.

The caller decides whether T35's "whole suite green" is accepted with P-2 recorded (as P-1 was) or waits for a fix of the spec.

## Defects

None new. D-1, D-2, D-3 are closed. For each: it was **found in the first pass**, so none is "new since the fix"; this pass found no
regression in what the fixes touched (every placement above was re-measured).

Observations (not defects):
- Every e2e run and every QE sweep adds a permanent retired category (AC-3.2, no delete): the dev Category filter lists 20+
  retired "E2E category …" entries now, plus "QE2 sweep …" from this pass.
- T46's own notes still stand for the main loop: `hours-api/src/test-support/testAuth.ts:8` still lists identities among what is
  "asked live"; the comments in `entries/list.routes.ts`, `entries/view.ts`, `labels/resolve.ts` were updated.
- The 360 px table observation of the first pass is unchanged and not re-measured (nothing in the diff touches layout).

## Exploratory regression sweep (real browser, `ui-sweep.mjs`, `sweep.out`; screenshots `qe2-sweep-*.png`)

My hours (employee persona): Record hours opened from the keyboard, focus on Day; Duration "2:30" reads "= 2 h 30"; Tab from Duration
lands on the "What was it on" radio (Project), three ArrowRight reach Other work; Save, "Entry saved.", the entry is listed; Escape from
the dialog returns focus to Record hours; Delete opens the alert dialog with focus on Cancel, confirm removes it, empty state back.
Everyone's hours (admin): This year, names read, no banner, read only (no Edit or Delete), Export downloads
`hours-2026-01-01_2026-12-31.xlsx`. Settings (admin): add, rename, retire, restore a category (no dialog on retire/restore), no Delete
control anywhere. 0 console or page errors. The first pass's flows F1 to F8 are not re-walked one by one: the diff changes two label
strings, two error strings and the name cache, all covered above.

## Tests I added

- `shell/e2e/hours.spec.ts` (commit 57814131), a fifth journey: "the design's date copy and a distinct name on every control of the hours dialogs, in
  English and Italian (D-2, D-3)": the Day and Custom period errors written out as literals (never read from the catalog) in My hours
  and Everyone's hours, and "no two buttons of one dialog share a name" for the entry dialog and all six Settings dialogs, plus a
  self-check that the detector finds a hand-made duplicate. **Seen to fail when the behavior is broken**: I reproduced each
  pre-fix behavior by rewriting the served hours-ui module in a temporary copy of the spec (no application file touched; the copy is
  removed): × named "Cancel" → fails at `en: categories: one "Close"`; the old empty-Day sentence → `en: an emptied Day`; the old
  Italian floor sentence → `it: a Day before the floor`; the old shared Custom sentence → `en: My hours, both Custom dates before the
  floor`. Passes unmodified (11 s). `tsc -p tsconfig.e2e.json`, ESLint and Prettier clean.

## Security

No new surface from my change (test code). The T46 cache was reviewed twice by the `owasp-reviewer` (`owasp-report.md`, both PASS, F1 / I1 /
I4 fixed in 2650fa89); this pass found nothing that changes that: the live rename and the budget runs behaved as the key and
viewer-independence argument says. No further pass needed for this round's diff.

## Environment I touched (cleaned)

Personas `qe2-*@operai.test` (users stay, as every e2e persona; all their hours entries deleted, the role `qe2-hours-readall` unassigned and
deleted), two more permanent retired categories ("QE2 sweep …", from two runs of the sweep), the scratch worktree and `hours-ui/coverage` removed, the temporary coverage
link removed, `git status` shows only my two files.

## Next

1. Caller: repair EF-2, EF-9, EF-10 and re-run the blocked specs (command above); then decide on P-2 (accept as pre-existing, or have the
   letterheads spec fixed). With those, T35's whole-suite row is the only open item for a PASS.
2. T40 (close) still needs the eval, which is not mine.

---

# FIRST PASS (history, superseded by the verdict above)


# QE report — specs/20261112-time-tracking (rigor: production, full mode)

First QE pass on this feature: no earlier `qe-report.md`. Full sweep (every AC, every `design.md` screen, state and
placement, every `plan.md` test-strategy row), listed before anything is fixed. Run 2026-11-18 by the quality engineer.

## QE verdict: FAIL   (measured at 309845fb; the code is the code of e78b6c95 and b374f5c7, the commits in between change only comments, `.betterleaksignore`, `owasp-report.md` and my own e2e test)

Three defects (one Medium, two Low), found by executing the app. Separately, the whole-suite e2e row of T35 is **BLOCKED**:
23 non-hours specs fail and 51 do not run, and every failure traces to the dev environment (stale databases, a stale
generated client, missing service clients), not to code this branch changes. Nothing in hours, the branch's own area,
failed in the suite: T35 4/4, T36 7/7.

### Checks I could not run to green here (named first)

| Check | Needs | What I did |
|---|---|---|
| `cd shell && pnpm e2e` (T35 done-when, whole suite) | a dev environment in step with `main` | ran it: 108 passed, 23 failed, 51 did not run (14.2 min). Cause of every failure established below (Environment faults). The caller repairs the environment and re-runs for that row only |
| betterleaks secret scan (the CI tool) | the `betterleaks` binary (not installed here) | ran `gitleaks 8.30.1` with the repo's `.betterleaksignore` instead: 0 findings in the 119 branch commits. Whole history: 24 findings, none in a branch commit (older test fixtures and a spec report). Recorded as a substitute, not as the pinned tool |

Everything else (gates, AC sweep, browser pass, API probes) ran.

## Verdict table

| Check | Threshold | Actual | Result |
|---|---|---|---|
| AC coverage (spec.md, 44 ACs) | 44/44 | 44/44 named by at least one executed, passing test (matrix below) | ✓ |
| T35 `hours.spec.ts` | passes, covers the done-when list | 4/4 (3 of T35 + 1 added by me), covers every listed behavior | ✓ |
| T36 `hours-owners.spec.ts` | passes | 7/7, including the R2 check | ✓ |
| Whole `pnpm e2e` (T35 done-when) | all green | 108 passed / 23 failed / 51 did not run; 0 in hours; all environment | BLOCKED |
| hours-api tests | all pass | 1812 pass, 0 fail (43 files, `hours_test`) | ✓ |
| hours-api coverage | ≥ 80 % lines | 99.20 % lines, 98.93 % functions | ✓ |
| auth tests / coverage | pass / ≥ 80 % | 951 pass; 97.51 % lines | ✓ |
| activities-api tests / coverage | pass / ≥ 80 % | 726 pass; 93.70 % lines | ✓ |
| meetings-api tests / coverage | pass / ≥ 80 % | 1960 pass; 96.73 % lines | ✓ |
| crm-api tests / coverage | pass / ≥ 80 % | 2145 pass, 1 fail = environment (EF-8, passes in a clean worktree); 95.74 % lines | ✓ |
| hours-ui lint, build, tests | pass | lint ✓, build ✓, 1504 tests pass (57 files) | ✓ |
| hours-ui coverage | ≥ 80 % lines | 98.66 % lines, 96.10 % branches (no provider configured in the app: measured with the shell's `@vitest/coverage-v8` linked in temporarily, link removed) | ✓ |
| shell lint, build, tests, coverage | pass / ≥ 80 % | ✓ ✓ 688 pass; 94.32 % lines | ✓ |
| operai-ui typecheck, lint, tests | pass | ✓ ✓ 317 pass; changed files (SearchPicker, ExportButton, Combobox, format) 98.97 % lines | ✓ |
| `mise run ui:check` | exit 0 | exit 0 (library, Storybook build, shell, refund-ui, meetings-ui, hours-ui) | ✓ |
| Other consumers of the changed `Combobox` | pass | crm-ui, projects-ui, admin-ui lint and tests ✓ | ✓ |
| Typecheck of every touched backend | exit 0 | hours-api, auth, activities-api, crm-api, meetings-api all 0 | ✓ |
| `mise run env:doctor`, `shared:check`, `react:skew`, `changeset:check` | exit 0 | all 0 (`shared:check`: 33 groups in sync) | ✓ |
| tools/env-doctor tests | pass | 262 pass, 1 fail: `push.test.ts` — **reproduces on `origin/main` (512851c2)**, not this branch | ✓ (pre-existing) |
| scripts tests | pass | 29 pass | ✓ |
| Dependency audit | no critical | none critical. hours-ui: 1 high (`picomatch` via `better-auth > vitest`, dev tooling), 1 moderate (`uuid` via `exceljs`, OWASP F7 accepted). hours-api: 2 high, 2 moderate, all inside `prisma` tooling (same as the sibling services) | ✓ |
| Secret scan (security floor) | 0 findings | 0 in 119 branch commits (gitleaks substitute, see above) | ✓ |
| Exploratory UI pass, every designed flow F1–F8 | walked | walked in the real browser (list below) | ✓ |
| Design states (design.md) | all present | every loading / empty / error / partial state of S1–S5 present and as designed | ✓ |
| Design copy (design.md § Date rules) | as written | five strings differ from the table (D-2) | ✗ |
| Accessibility (design.md) | keyboard + ARIA per design | keyboard path, focus rules, ARIA hold; one duplicated accessible name (D-3) | ✗ |
| Capacity of the name lookup (plan R2 / AC-4.8) | a normal session stays within auth's budget | 120 lookups per person per 10 min; one Everyone's-hours filter change spends 3 (D-1) | ✗ |
| Component reuse (design.md inventory) | reuse, no new duplicate | `SearchPicker`, `ExportButton`, `formatMonth` in the library as planned; no hand-rolled table or dialog in hours-ui | ✓ |

## Defects

### D-1 — Medium — capacity: the viewer's name lookups share auth's 120-per-10-minutes budget and nothing budgets them
Class: a shared per-person rate limit spent by ordinary use. Owner: **architect** (plan drift), then backend-dev.

- Root cause. hours-api resolves every name live from `auth POST /authz/users/identities`, forwarding the VIEWER's Bearer, with no
  cache (`hours-api/src/lib/identities.ts`: "one call per read is all a viewer makes"; no cache because of AC-4.8). `auth` limits
  that endpoint to `IDENTITIES_RATE_LIMIT=120` per caller `sub` per `IDENTITIES_RATE_WINDOW_MS=600000`
  (`auth/src/lib/env.ts:100-101`, `auth/src/authz/identities.routes.ts:175-186`). The plan never mentions the limit; the e2e hit it
  on 2026-11-16 and worked around it in the test (one admin per run, `decisions.md` T35/T36, af55c687) instead of raising it.
- Effect. After the 120th name lookup in a window every name reads "Unknown user" and the info banner says names could not be
  loaded. Entries, minutes and totals stay right (fail-soft, as designed) and it recovers when the window slides. The audience hit
  first is the oversight holder, who changes filters often.
- Measured (live, fresh persona): 1 create + 119 `GET /time-entries?whose=mine` list reads spend 120; the next read returns
  `unavailable:["identities"]` and `person.status:"unknown"`. A second persona: 100 totals calls with `groupBy` day / project /
  deal / category / month first (no names) spent nothing; the list then failed at the same 120th lookup. Repro, 25 lines: the
  scratchpad scripts `/private/tmp/claude-331608204/-Users-edoardo-paronzini-Work-Experiments-operai/f2ce1f1a-3ebd-4e72-83ca-8155e69a4eef/scratchpad/probe/rate.py` and `rate2.py`
  (mint a token for `qe-rate-N@operai.test`, `POST /time-entries`, then loop the list until `unavailable` holds `identities`).
- Placements, one lookup each unless stated:

  | Where | Lookups per action | Hits 120 after |
  |---|---|---|
  | My hours: load, filter change, Load more, Save (POST view + reload), Edit, Delete (reload) | 1 per list page or write view | ~120 actions in 10 min |
  | Everyone's hours: load or any filter change | 3 (list, `groupBy=person` totals, Person options `groupBy=person`) | ~40 filter changes in 10 min ✗ |
  | Export walk | 1 per page of 500 | 120 pages ✓ |
  | `groupBy` day, project, deal, category, month | 0 | never ✓ |
  | Settings | 0 | never ✓ |

  The budget is per person across every caller of that endpoint, and the callers forward the viewer's own Bearer: estimai-api
  (cached, requests paced one batch at a time, `estimai-api/src/lib/authClient.ts:136-160`) and activities-api (60 s cache,
  `activities-api/src/lib/identities.ts:31`, behind the CRM and Projects task lists) draw from the same 120. hours-api is the one
  caller with neither a cache nor pacing, and what it spends comes out of the budget those screens need.
- Suggested directions for the architect (not prescribed): a short TTL cache keyed by id that still shows a rename within seconds
  (AC-4.8 asks for the new name, not for zero staleness); one lookup per request shared by list, totals and options; or a higher
  limit for this endpoint. Whichever is chosen goes into the plan's Risks and the AC-4.8 test row.

### D-2 — Low — design copy: five strings differ from the exact table in design.md § "Date rules — copy"
Class: copy not as designed. Owner: **frontend-dev** (or the designer amends `design.md` if the build's wording is preferred; the
deviation is recorded nowhere in `decisions.md`).

| Placement | design.md says | build says | Verified |
|---|---|---|---|
| Entry dialog, Day, not a calendar day (en) | "Choose a valid day." | "Choose a real calendar day." (`strings/entry.ts:135`) | by reading; the empty field says "Choose a day." (a separate `dayRequired`, where the design table groups the empty field with this case) |
| Entry dialog, Day, not a calendar day (it) | "Scegli un giorno valido." | "Scegli un giorno che esista nel calendario." (`entry.ts:299`) | by reading |
| Entry dialog, Day before 01.01.2000 (it) | "Il giorno non può precedere il 01.01.2000." | "Il giorno non può essere precedente al 01.01.2000." (`entry.ts:300`) | by reading |
| My hours, Custom period, From and To before the floor (en, it) | "The start date…" / "The end date…" (it: "La data di inizio…" / "La data di fine…") | one sentence for both fields: "The date cannot be before 01.01.2000." / "La data non può essere precedente al 01.01.2000." (`strings/filters.ts:53,133`) | live: with both fields wrong the page shows two identical alerts, `The date cannot be before 01.01.2000. \|\| The date cannot be before 01.01.2000.` |
| Everyone's hours, Custom period (same strings) | as above | as above | same `HoursFilters`/catalog; not rendered separately |

### D-3 — Low — accessibility: two controls with the same accessible name in the Settings dialogs
Class: duplicated accessible name. Owner: **frontend-dev**.

- `hours-ui/src/components/TimeListItemDialog.tsx:111` passes `closeLabel={strings.common.cancel}`, so the × button and the
  footer button are both named "Cancel" (a locator `getByRole('button', {name:'Cancel'})` inside the dialog resolves to 2 elements). The
  entry dialog and the delete confirmation use "Close" for the ×.
- Placements (one component, five uses): Add category ✗, Rename category ✗, Add project work type ✗, Add deal work type ✗, Rename
  work type ✗. Entry dialog ✓ ("Close"), delete confirmation ✓ ("Close").
- Note: the same habit exists in `admin-ui` and `refund-ui` dialogs (suite-wide); this feature moved the dialog from admin-ui
  (D51). The fix belongs in hours-ui whatever the suite decides.

### Observations (not counted as defects)

- 360 px, tables. No page-level horizontal scroll anywhere (`document.scrollWidth` 360 on My hours, Everyone's hours, Settings).
  `DataTable` scrolls inside its own region, as the library and design.md describe, but it is narrow there (205 px visible):
  Everyone's entries shows Day, Person and part of On, so Details and **Time** are off-screen; the Settings tables cut off
  **Actions** (Rename, Retire) and, on Categories, Status too. Placements: Everyone's entries ✗ (UX), Everyone's totals ✓, My hours totals ✓, My hours day
  list ✓ (it is a list of cards), Settings categories ✗, project work types ✗, deal work types ✗. Designer's call whether a
  narrow layout is wanted. Screenshots: `/Users/edoardo.paronzini/Work/Experiments/operai/.playwright-mcp/qe-360-everyone.png`,
  `qe-360-settings.png`, `qe-360-my-hours-tall.png` (same directory).
- A person typing "30" in Duration gets "Between 30 minutes and 24 hours." (it reads 30 hours, as the design says: hours alone,
  minutes need `m`). Correct per design; a hint toward "30m" would save a retry.
- URLs the router writes carry a trailing slash (`/hours/?target=project`). Cosmetic.
- A query-string violation from hours-api says `detail: "body: Unrecognized key"`. Cosmetic.
- Every e2e run adds a permanent retired category (AC-3.2: no delete), so the dev Category filter now lists 12+ retired "E2E category …".
- `design.md` front matter still says `status: draft` while the build follows it. Process note for the main loop.
- The branch touches files no task lists: `.github/workflows/changeset-check.yml`, `.forge/id-migration.json`,
  `auth/src/system/systemCapacity.contract.test.ts`, `shell/src/italian.test.tsx`, `.changeset/hours-api-zod-4.md`, and
  `operai-ui/src/components/Combobox.tsx` (Escape now stops propagation so a dialog around a popup stays open: covered by
  `Combobox.test.tsx`; crm-ui, projects-ui, meetings-ui, refund-ui, admin-ui suites green on it).

## Environment faults (not defects: no owning dev agent, no fix round)

Whole-suite e2e on this tip: 182 specs, 108 passed, 23 failed, 51 did not run (serial describes after a failure). Run command (the
documented recipe for the dev stack): `cd shell && E2E_ESTIMAI_REMOTE_PORT=5174 E2E_REFUND_REMOTE_PORT=5175 E2E_NOTIFY_REMOTE_PORT=5176
E2E_ADMIN_REMOTE_PORT=5177 E2E_INVENTORY_REMOTE_PORT=5178 E2E_CRM_REMOTE_PORT=5179 E2E_MEETINGS_REMOTE_PORT=5180
E2E_PROJECTS_REMOTE_PORT=5181 E2E_LETTERHEADS_REMOTE_PORT=5182 E2E_HOURS_REMOTE_PORT=5184 pnpm exec playwright test --reporter=list,json`.
Results: `/private/tmp/claude-331608204/-Users-edoardo-paronzini-Work-Experiments-operai/f2ce1f1a-3ebd-4e72-83ca-8155e69a4eef/scratchpad/e2e-full.json` and `e2e-full.log` (same directory). Not one
failure or skip is an hours spec. Branch changes: `git diff --name-only origin/main...HEAD` touches none of refund-api, refund-ui,
inventory-api, inventory-ui, notify-api, letterhead-api, letterheads-ui.

| # | Failing specs (failed + skipped) | Cause, with the evidence | Touches branch code? | Repair (a person) |
|---|---|---|---|---|
| EF-1 | `inventory-assignment`, `inventory-ledger` (2 + 2) | `GET /fiscal-years?entity=…` → 500 `The column asset.holderOfficeId does not exist in the current database`; Postgres log: `column asset.holderOfficeId does not exist`, `relation "public.office" does not exist`. `prisma migrate status` on the dev `inventory` DB: `20261118100000_offices` and `20261118160000_assignment_reminders` not applied | no | `mise run db:migrate` |
| EF-2 | `crm-offer-wizard`, `-pages`, `-revise` (3 + 23) | fixture `POST /deals/:id/estimate/override` → 503 `activities_unconfigured`; raised only when `ACTIVITIES_API_URL` is unset (`crm-api/src/lib/activities.ts:134`, `env.ts:91`). The running crm-api (pid 92877, started 15:02:12) still answers it, so the variable is not in effect in that process (the caller's note says it is set: it needs a restart, or the value is where Bun does not load it). Even set, auth's `SERVICE_CLIENTS` gives `crm-api` no `activities.write` (EF-6). Behind that, the dev `crm` DB lacks `20261117015314_offer_letterhead_version` (Postgres log: `column deal_offer.letterheadVersion does not exist` ×5) | no (crm-api change is `activity-host/resolve*` only) | set `ACTIVITIES_API_URL`, restart crm-api; `mise run db:migrate`; EF-6 |
| EF-3 | `meetings-deal` (2 + 0) | a meeting stays `processing`; the page never lists the meeting. Postgres log: `relation "public.meeting_attachment" does not exist` ×14. `migrate status` on `meetings`: `20261117120000_meeting_attachments` not applied | no: the failing statement is main's attachments query; the branch adds `?ids=` and `/system/meetings/hosts` | `mise run db:migrate` |
| EF-4 | `letterheads`, `-access`, `-browser-contract`, `-versions`, `crm-offer-wizard-service` (5 + 23) | `PUT /admin/roles/{id}/rules` → 422 `Unknown permission: "letterheads.access" is not registered in the catalog`. The dev auth DB's `catalog_resource` holds admin, crm, estimai, hours, inventory, meetings, projects, refund: no `letterheads` (the catalog is in the code, `auth/src/authz/catalogs/letterheads.ts`, from main). The service-side `GET /v1/letterheads` → 403 is consistent with it, not separately proven | no | `cd auth && bun run db:seed` (or `db:release`) |
| EF-5 | `push-notifications` (5 + 0; 1 passes) | the spec's own assertion: notify-api `GET /push/config` answers `enabled:false` ("ENV: notify-api must run with PUSH_ENABLED=true") | no | `PUSH_ENABLED=true` and a VAPID pair on notify-api, restart |
| EF-6 | `activities-notify` (1 + 0) | the assignee never gets the notification (reproduced alone, 30 s, same result). The running `auth` environment lists service clients `inventory-api, estimai-api, refund-api, crm-api, projects-api, hours-api` only (ids and scopes read from the process environment block, secrets not printed): **no `activities-api`** (needs `notifications.push emails.send`), no `meetings-api`, and `crm-api` without `activities.write`. activities-api cannot mint its notify credential, and its push is best effort. Not proven from activities-api's own env (protected file) | no (the branch adds `GET /activities?ids=` only) | add the clients and scopes to auth's `SERVICE_CLIENTS` (`auth/.env.example`, `infra/README.md`), restart auth |
| EF-7 | `refund-headline`, `refund-batches-headline`, `refund-settings`, `self-approval-control`, `mileage-rate` (5 + 3) | `PUT /review/requests/:id/lines/:lineId/approved-total` → 500 `Unexpected database failure setting the approved total`, reproduced 3 of 3 with curl. Cause: **the generated Prisma client of refund-api is stale** — `refund-api/src/lib/generated/prisma/models/RefundLine.ts` has 0 occurrences of `rejectionReason`, the schema has it (`prisma/schema.prisma:296`). Prisma says `Unknown field rejectionReason for select statement on model RefundLine`. Not a DB problem: a `pg_dump -s` of the dev `refund` DB equals a freshly migrated `refund_test` (only the `\restrict` token lines differ), and refund-api's own `bun test src/review/decide.routes.test.ts` on that fresh DB fails 47 of 58 with the same message. A regenerated client has 46 occurrences | no | `cd refund-api && bunx prisma generate`, restart refund-api |
| EF-8 | crm-api unit test `offerDrafts.preview.test.ts:627` (1 fail of 2148) | the test boots a child with `cwd: crm-api`; Bun autoloads crm-api's gitignored dotenv, which defines `SERVICE_CLIENT_*`, so the "no service client" case starts instead of refusing. In a clean `git worktree` of HEAD (no dotenv; `node_modules` and the generated client linked in) the same test passes, 2 of 2 | no (file untouched) | none needed; run in a clean tree |

Pre-existing on `main`, with evidence: `tools/env-doctor/push.test.ts` expects `PUSH_ENABLED=false`; the production template says
`PUSH_ENABLED=true` since 2026-11-13. A worktree of `origin/main` (512851c2) fails the same test with the same message; the
branch's diff on both files is empty.

## AC sweep (executed; test files that name each AC)

Counts are files that name the AC, per level (api = hours-api, ui = hours-ui, e2e = hours + hours-owners specs, other = auth,
crm-api, meetings-api, activities-api, operai-ui, shell, env-doctor). Every file ran and passed in the runs above. Where a plan row
names a level, I confirmed that level exists.

```
AC-1.1 api2 ui2 e2e1 | AC-1.2 api3 ui3 e2e1 | AC-1.3 api2 ui3 | AC-1.4 api2 ui2 | AC-1.5 api2 ui4 | AC-1.6 api4 ui5
AC-1.7 api2 ui1 | AC-1.8 api3 ui2 | AC-2.1 api3 ui1 | AC-2.2 api3 ui2 e2e1 | AC-2.3 api4 ui1 e2e1 | AC-2.4 api3 ui2
AC-2.5 api3 ui1 | AC-2.6 api6 ui4 e2e1 | AC-2.7 api5 ui3 | AC-2.8 api2 | AC-2.9 api4 ui4 | AC-2.10 api8 ui3
AC-2.11 api8 ui2 | AC-2.12 api4 ui4 | AC-3.1 api4 ui3 e2e1 | AC-3.2 api6 ui2 | AC-3.3 api3 ui2 e2e1 (+ the added test)
AC-3.4 api3 ui10 e2e1 | AC-3.5 api2 ui1 | AC-3.6 api1 ui3 | AC-3.7 api2 ui1 | AC-3.8 api2 ui10 | AC-4.1 api2 ui2 e2e1
AC-4.2 api6 ui1 | AC-4.3 api1 ui4 e2e1 | AC-4.4 api4 ui6 | AC-4.5 api4 ui4 e2e1 | AC-4.6 ui6 e2e1 (+ other2)
AC-4.7 api9 ui10 | AC-4.8 api3 ui7 | AC-4.9 ui7 e2e1 (+ operai-ui) | AC-4.10 api6 ui16 e2e1 | AC-4.11 api5 ui10 e2e1
AC-5.1 api3 ui1 e2e1 | AC-5.2 api3 (+ auth) | AC-5.3 api3 (+ other) | AC-5.4 api4 ui1 | AC-5.5 ui9 e2e1 (+ shell)
```

Beyond the files, I executed these against the running stack: the AC-1.2 / 1.3 / 1.7 / 2.1 / 3.6 / 4.2 validation edges and the
403 / 404 / 401 boundaries over HTTP (`probe/api1.sh`: 36 requests, all as specified); the AC-2.2 / 2.3 / 2.6 / 4.6 journeys by
T36 against the real owners; the AC-4.6 export file opened and summed (see below).

## Exploratory pass (real browser, dev stack, `admin@operai.test` and `@operai.test` personas, never Google or GitHub)

| Flow / screen | Walked | Result |
|---|---|---|
| F8 reach: user menu "My hours" / "Le mie ore" after My meetings; no session → sign-in redirect keeping the path; hours remote down → in-place "Impossibile caricare Ore" + Retry; typed unknown path → not-found with focus on the heading | ✓ | as designed |
| F1 record (S2): focus on Day, Day `min` 2000-01-01 and `max` today; Duration typed: 81 inputs in two batches (`2:30 0:30 2,5 2.5 8 2h30 2h 30 2 h 30 90m 90 min 24 24:00` read; `2:15 0 0:00 24:30 25 abc 2:75 -1` and empty refused with the design's three messages; also `1e1 0x10 Infinity 2:30:00 1.50000000001 1441m` refused, `1440m 24h 0h30 2H30` read); "= 2 h 30" echo is a polite live region; required note error moves focus to Note; nothing preselected; fields per target match the matrix; 403 pickers say "You can't search projects/deals"; double-click on Save sends one POST | ✓ | as designed (copy: D-2) |
| F2 edit / "not visible" variant: PATCH body carries only changed members (`{"minutes":180}`); the hidden variant shows "Not visible to you", Activity locked, no activities-api read, saves `{"minutes":120}`; a note typed and erased sends nothing; D50 live (entry recorded without a note, category then flagged to need one, minutes-only edit sends `{"minutes":90}` and saves); an entry deleted elsewhere → "…non si trova più" and the list reloads on close | ✓ | as designed |
| F3 delete: `alertdialog`, focus on Cancel, Escape cancels, confirm removes the row, focus to the page heading, "Entry deleted." | ✓ | as designed |
| F4 My hours (S1): filters (Period, Recorded on → `target` in URL, list, day totals and group totals; a bogus `?target=` ignored; Clear filters; Custom range errors and no request while one shows); Totals; day totals from `groupBy=day`; Load more (300-row page, failed page keeps the rows with "Try again", retry completes, a day total unchanged by paging); banners for `unavailable[]`, hidden names, `meeting-deals`; all five error and loading states (list 500, totals 500, day totals 500, lists 500, hang → "Loading totals…" / "Loading your hours…") | ✓ | as designed |
| AC-4.11 deal filter + `host_unavailable`: Totals and Entries replaced by ONE alert (Clear the deal filter, Retry), no empty state, no "0 min", no Export; focus stays in the picker on appear, goes to the alert after a failed Retry, to the Totals heading after a good one | ✓ | as designed |
| F5 export: file `hours-2026-11-01_2026-11-30.xlsx` / `hours-2026-01-01_2026-12-31.xlsx`; nine columns in order; Hours numeric `0.0`, sum 645 over 277 rows; under Recorded on = Other work the file holds the 8 entries the screen shows; Italian sheet "Ore" and headers | ✓ | `qe-export-all.xlsx`, `qe-export-other.xlsx` |
| F6 Everyone's hours (S4): tabs, read-only table (no Edit/Delete), Person options from `groupBy=person` without `userId` and refetched only when another filter changes, default group Person, captions; `503 authz_unavailable` → warning + Retry + "your own hours are not affected"; `403 read_all_required` → denied panel, focus on its heading | ✓ | as designed |
| F7 Settings (S5): three cards, A15 rows, Add (empty, duplicate case-insensitive, 81 characters, requires-note), Rename prefill, Retire / Restore (no dialog, banner, focus to the new toggle, retired row moves after the active ones), no Delete anywhere | ✓ | as designed (D-3 on the dialog's ×) |
| Permission combinations (live, roles made through the admin API and removed): `time-list:manage` alone → tabs "My hours, Settings", lists reachable, `/hours/all` denied with no `whose=all` call; `time-entry:read-all` alone → "My hours, Everyone's hours", `/hours/settings` denied with no list call | ✓ | now an e2e test (below) |
| Keyboard only: Record hours → filters → Group by → table region → Export → rows (name link, Edit, Delete); dialog opens on Day; radio group by arrows; meeting picker by ↓ Enter; first Escape closes the popup and leaves the dialog, second closes the dialog and returns focus | ✓ | as designed |
| Italian: My hours, dialog and its errors, Everyone's hours, Settings and dialogs, export headers, user menu, About ("ORE 0.2.0") | ✓ | complete; list names stay as typed (AC-3.8) |
| Themes and 360 px | both themes ✓; 360 px: no page-level overflow; table regions narrow | see Observations |
| Text safety: a note holding `<img onerror>`, `&amp;`, `<b>` renders as text (`window.__xss` undefined, 0 `img`, 0 `b` in the row) | ✓ | |

Screenshots, all under `/Users/edoardo.paronzini/Work/Experiments/operai/.playwright-mcp/`: `qe-s1-desktop.png`, `qe-light.png`,
`qe-360-my-hours-tall.png`, `qe-360-everyone.png`, `qe-360-settings.png`, `qe-everyone-it.png`, `qe-hidden-states.png`,
`qe-loading.png`, `qe-floor-keyboard.png`.

### R2 early check (T36, reported, not failed)

`POST` on a deal (owner) p95 8 ms; via task assignee 12 ms; `GET whose=all` a month 9 ms; `groupBy=deal whose=all` a year 7 ms;
export walk of a quarter (1115 entries, 3 pages) 36 ms; in-browser export click to file 173 ms. All far under the 800 ms line.

## Tests I added

- `shell/e2e/hours.spec.ts` (+ `shell/e2e/helpers/hoursFixtures.ts`: `ensureRole`, `deleteRoleQuietly`), commit 309845fb: a fourth
  journey for AC-3.3 as amended by D51 and AC-4.2, which no other test runs in a browser: a role holding only `time-list:manage`
  and one holding only `time-entry:read-all`, made through the real admin API and deleted afterwards. It passes (4/4). **Seen to
  fail when the behavior is broken**: with the lists role given `time-entry:read-all` instead, the run stops at
  `expect(listsTabs.getByRole('link')).toHaveText(['My hours','Settings'])`. `tsc -p tsconfig.e2e.json`, ESLint and Prettier clean.

## Not run, and why it does not block the verdict

- A manual screen-reader read-back of "2 h 30" (design.md a11y plan asks QE to check NVDA / VoiceOver): no screen reader on this
  machine. The duration echo is `aria-live="polite"` and the row carries a spoken form ("2 hours, 30 minutes"); read-back itself
  is unverified. verified by: nobody yet — a person with VoiceOver or NVDA closes it.
- Live loss of an owner during a write (AC-2.11 against the real projects-api, crm-api, meetings-api): I cannot stop the
  owners; the fail-closed paths are proved by the 1812 hours-api tests against the scriptable fake hosts and by the browser
  banners with injected 503s.

## Security

No new surface from my change (test code). The OWASP re-check of the delta since 2026-11-16 is already committed
(`owasp-report.md`, b374f5c7, PASS). D-1 changes how names are fetched: an `owasp-reviewer` glance is worthwhile only if the
architect picks a cache (the cache key and the viewer scoping must not leak a name across viewers).

## Next

1. Caller: repair the environment (EF-1 to EF-7), re-run `cd shell && pnpm e2e` for the failing specs and the whole suite.
2. Architect: D-1 (plan). Frontend-dev: D-2 and D-3. Then a QE pass for those placements only, plus the whole-suite row.
