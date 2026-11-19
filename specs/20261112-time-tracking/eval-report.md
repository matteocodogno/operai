---
spec: 20261112
evaluated: 2026-11-19
rubric: default-v2
score: 83.5
verdict: PASS
---
# Eval report: Time tracking — the hours employees spend on company work

**Rubric:** `default-v2`, the plugin's bundled copy
`/Users/edoardo.paronzini/.claude/plugins/cache/wellforge/wellforge/2.61.0/config/eval-rubric.yml`. Neither
`gates/configs/eval-rubric.yml` nor `.wellforge-gates/gates/configs/eval-rubric.yml` exists in this repo. The feature has no
`eval.md`, so no overrides apply. `design.md` exists, so `design_fidelity` applies and the total is normalised over
115 weight points.

**What was judged:** branch `feat/time-tracking` at `65db8fe8`, against its merge base `512851c2` (`git diff 512851c2...HEAD`:
366 files, +66 670 / −107). The 15 commits `origin/main` has gained since were not judged.

**What I ran myself (evaluator, 2026-11-19):**

- hours-api: `bun run typecheck` exit 0, and `bun test --coverage` on `hours_test` (the preload in
  `src/test-support/env.ts` forces the `_test` database). Result: 1871 pass, 0 fail, 45 files, 99.20 % lines, 98.94 % functions.
- hours-ui: `pnpm lint` exit 0, `pnpm test` 1523 pass in 57 files, `pnpm build` exit 0.
- shell, the files on the hours seam (`router.hours`, `UserMenu`, `tools`, `session`, `italian`, `noHardcodedStrings`,
  `AboutModal`, `runtimeRemotes`): 175/175 under the mise-pinned Node 24.22.1. Under the global Node 26 the run
  showed 28 failures, all `localStorage` undefined. That is my environment: pnpm resolved Node 26, not Node 24.
  It is not a defect in the branch.
- auth: the non-database tests for the hours catalog and the service client, 57/57.
- `mise run shared:check`: 33 groups in sync. `mise run changeset:check`: OK.

I did not re-run the e2e. The QE's three passes are the evidence for it.

| Dimension | Weight | Score (/5) | Floor | Weighted | Evidence |
|---|---|---|---|---|---|
| AC satisfaction | 35 | 4 | 4 | 28.0 | **All 44 ACs met.** QE's AC sweep found 44/44 named by passing api, ui or e2e tests (qe-report.md first pass § AC sweep). The QE also ran 36 API probes of the validation edges and the 401/403/404 boundaries, and walked F1–F8 in a browser. My re-runs are green (above). E2e against the real owners covers AC-2.2, 2.3, 2.6, 4.6 and 4.11 with the route up (`hours-owners.spec.ts:177,210,234,276,331,375`), plus AC-1.1, 3.1, 3.3, 3.4, 4.1, 4.3 and 5.1 (`hours.spec.ts:86,135,203`). AC-4.8 was checked live: a rename showed after 55 s (qe-report pass 2). Thin: see Findings |
| Spec fidelity | 20 | 4 | 3 | 16.0 | The contracts are as planned. The `meetingId`/`target` filters and the 10-page deal scan were already in the plan approved on 2026-11-12 (`git show 8c36a2d4:…/plan.md` lines 61, 251). Every spec change went through the owner: D44 (AC-4.10), D46 (AC-2.12), D48 (AC-4.11), D50 (AC-3.6), D51 (AC-3.3), D52 (AC-4.4), D53 (design S2) (ledger.md:91-100). Minor documented additions: see Findings |
| Test quality | 20 | 5 | 3 | 20.0 | Every plan § Test strategy row (44/44) names tests that assert the failure mode. One example is `withheldIds.test.ts`, which checks the whole response body for leaked hidden ids, `nextCursor` included. Cross-cutting checks: fail-closed probes per owner (`bookability.test.ts:148-168,299-324,446-479`), byte-identical 404 bodies, an authorization matrix over the assembled app (`matrix.test.ts`) and an OpenAPI pin. Each regression test was seen to fail when its behaviour was broken: the identities budget test failed against the uncached client with 110 × 429 (decisions.md § T46), QE killed seven mutants of `identities.ts` (pass 2), and the QE's own e2e failed on reproduced pre-fix behaviour (pass 2 § Tests I added). Strings are protected by an AST scanner for hardcoded copy and a catalog parity test |
| Code quality | 15 | 4 | 3 | 12.0 | Idiomatic Bun + Hono + zod-openapi with Problem JSON. `index.ts` puts the session guard before every route and caps bodies at 64 KiB. Owner calls take 2 s, use `redirect:"error"` and fail closed (`targets/bookability.ts`). A refusal is cached, a grant never is (`oversight/oversight.ts:66-90`). Every write is scoped to `{id, userId}` in the statement itself (`entries.routes.ts:351-377`). The name cache is clocked from when the request was sent and never stores a failure (`lib/identities.ts`). No hallucinated APIs or dependencies. Nits: see Findings |
| Design fidelity | 15 | 4 | 3 | 12.0 | `design.md` covers F1–F8 and S1–S6 with every loading, empty, error and partial state, an a11y plan (keyboard, focus, ARIA per screen) and a component inventory mapped to `@operai/ui` (22 reused, 2 new library components with story and test). QE walked every flow and state in a browser (pass 1 § Exploratory). D-2 (copy) and D-3 (duplicate accessible name) were fixed and rendered in en and it (pass 2). Thin: stale a11y text, screen-reader readback not done (Findings) |
| Trajectory | 10 | 4 | 2 | 8.0 | Run trace `2026-11-18T14-00-00Z-orchestrate-20261112-time-tracking.json` (v3) records the closing phase in order: QE FAIL → architect plan amendment, approved by the user → frontend-dev D-2/D-3 and backend-dev T46 → owasp T46 PASS → QE BLOCKED. QE pass 3 (`fbb298d1`, `82baa5dd`) came after the trace was written. One fix round of two was used. Git shows one commit per task (T1–T46) in dependency order, each followed by a "checked; decisions recorded" commit. Gap: no run trace for the implementation phase (Findings) |
| **Total** | 115 | | | **96.0 → 83.5/100** | normalised over the 115 applicable weight points (96.0 / 115 × 100) |

**Verdict: PASS.** 83.5 ≥ 80, and every applicable dimension is at or above its floor. AC satisfaction is exactly at its floor of 4.

**Scope:** per the user's instruction of 2026-11-19, relayed by the coordinator, only what this PR touches was judged. That is the files of
`git diff --name-only origin/main...HEAD` (merge base `512851c2`) and their behaviour. The e2e failures in other features' tests that QE
recorded as independent of the branch are not findings here.

## Findings

### AC satisfaction (4): what keeps it from 5

- **AC-2.11 (fail closed) was never seen against a real owner outage.** The proof is the hours-api tests against scriptable
  fake owners (`bookability.test.ts` "is 503 host_unavailable…", `deals.test.ts`, `activityPointer.test.ts`) plus browser banners with
  injected 503s. The QE could not stop the real owners (qe-report pass 1 § "Not run").
- **AC-2.8 and AC-2.9 are proven by integration tests only.** AC-2.8 is "two people, three days, one task". AC-2.9 is
  "fake activities-api stops returning the id". No live journey deletes an activity that entries point at.
- **AC-2.3 has a bound.** The deal-activity scan reads at most 10 pages (1 000 activities). A person involved only through an activity past
  that bound is refused with 403 `not_involved_in_deal` (`targets/bookability.ts:107-118`, R9). The bound was in the user-approved plan
  of 2026-11-12, and the refusal is logged so it can be counted, so it is not drift. It is still a narrowing of the AC's
  wording, in the plan and not in the spec.
- To raise it to 5: one e2e write with a real owner stopped (the 503 and nothing written), and one e2e that deletes a pointed task
  and checks the entry stays listed without its activity.

### Spec fidelity (4)

- **The 01.01.2000 floor** on `day`, `from` and `to` is a product bound that no AC states. It comes from plan amendment 4 and guards
  Postgres from year 0, which would otherwise be a 500. design.md:766-772 surfaces it to the owner as "UI present that no AC asks for".
- **The `Combobox` Escape `stopPropagation`** (`operai-ui/src/components/Combobox.tsx:141`) was changed outside T4's touch list.
  It is recorded (decisions.md:48), every consumer suite passed, and it is a fix.
- **crm-api's deal resolve answers a constant `may:{write:true, manage:true}`** for any `crm:access` reader
  (`crm-api/src/activity-host/resolve.routes.ts:158`). It was copied from the plan's contract, and hours-api ignores it.
  The risk is recorded (decisions.md § T7): a later consumer could read it as `deal:manage`.
- Plan amendments 1–8 and 10 are architect "contract corrections" with no recorded owner approval. Each states "no AC, endpoint or
  feature added", and I found none added.

### Code quality (4)

- The `may` constant above.
- A stale comment at `hours-api/src/test-support/testAuth.ts:8` still lists `/authz/users/identities` as "asked live"
  (decisions.md § T46 observation).
- `axe-core` is a devDependency in `hours-ui/package.json:34` but is imported nowhere in `hours-ui/src`. Several other apps
  carry the same unused dependency.
- R10: hours-api's copies of the identities client and of the oversight check are not drift-checked by
  `scripts/check-shared-copies.ts`. This is accepted in the plan, with a follow-up chore.

### Design fidelity (4)

- The `design.md` front matter still says `status: draft` (line 3), although the build follows it.
- After D53 made Duration a text field, two passages went stale:
  - The Accessibility § still describes a "**Duration select**" with native typeahead (design.md:694).
  - The AC coverage § says "the control cannot hold an invalid duration" (design.md:764).

  The S2 field table was updated (design.md:356), but the a11y plan for the changed control was not.
- The screen-reader readback of "2 h 30" that the design asks QE to check (design.md:694-697) is unverified:
  "verified by: nobody yet" (qe-report pass 1).
- At 360 px, the Everyone's entries and Settings tables cut off Time and Actions inside their scroll region. The QE recorded this as an observation for the designer.
- To raise it to 5: refresh the a11y § for the typed Duration (its `aria-live` echo, error timing), and have a person run the
  NVDA or VoiceOver check.

### Trajectory (4)

- **There is no run trace for the implementation phase** (T1–T45, 2026-11-13 to 2026-11-16). What shows the right agents ran in the right
  order is git (one feat commit and one "checked; decisions recorded" commit per task) and `decisions.md`. Those show it, but they are
  not a trace. The one trace still says `result: partial` and "No eval (QE not PASS)", because it predates QE pass 3. The main loop
  updates it after this verdict.
- In the trace's favour: QE ran three passes, and the owasp-reviewer ran three times. Environment faults were repaired by the main loop
  and the user, never by changes to application code. The main-loop commits after the rebase (`ac31530b`, `a36d9d16`, `e78b6c95`,
  `b374f5c7`) are a port move, a shared-copy sync, configuration and docs.
- *Context only, per the user's scope instruction of 2026-11-19, and not scored against this feature.* T35's done-when was amended after QE pass 3
  (`b891e73f`) because the old wording could not hold on one stack. The whole-suite e2e failures QE recorded live in other features'
  tests: letterheads, crm-offer-wizard and notifications (qe-report pass 3, P-2, P-2b, P-3, Q-1, Q-2, EF-12). The user accepted them as
  independent of this branch. The hours journeys passed 12 of 12 in all three runs.

## Recommended next step

- **PASS → the spec may move to `done`** through T40 (`/wellforge:done 20261112-time-tracking`).
- Before PR #10 merges: rebase onto `origin/main`, which is 15 commits ahead, with 20 files changed on both sides (qe-report pass 3
  § Observations). Then re-run the gates and the hours e2e (`hours.spec.ts`, `hours-owners.spec.ts`).
- Follow-ups, none of them blocking, for whoever owns each:
  - design.md: the a11y § for the typed Duration, and the front-matter status.
  - A person runs the NVDA or VoiceOver readback of "2 h 30".
  - The stale `testAuth.ts:8` comment.
  - Document or narrow the `may` constant of crm-api's deal resolve.
  - The R10 drift-check groups.
