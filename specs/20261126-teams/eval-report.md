---
spec: 20261126
evaluated: 2026-11-27
rubric: default-v2
score: 82.6
verdict: PASS
---
# Eval report: Teams — named groups of people, managed in Admin, taking part in projects (round 3)

Rubric: `default-v2`. I read it from `/Users/matteocodogno/.claude/plugins/cache/wellforge/wellforge/2.66.0/config/eval-rubric.yml`, the
bundled copy of the installed plugin (`installPath` of `wellforge@wellforge` in `~/.claude/plugins/installed_plugins.json`).
`gates/configs/eval-rubric.yml` and `.wellforge-gates/…` are not in this repo. There is no `specs/20261126-teams/eval.md`, so no
overrides apply. `design.md` exists, so `design_fidelity` applies and the weight pool is 115.

Scope of this round: `99183a06..04450b94`. `git diff --stat 99183a06..HEAD` lists four files, all documentation:
- `specs/20261126-teams/design.md` (§ Copy register rule, the Italian copy rows, the badge note at 192-194);
- `specs/20261126-teams/tasks.md` (a "Fix rounds" section);
- `docs/adr/20261126-a-host-says-unknown…md` (§ Evidence);
- `.forge/runs/2026-11-26T09-00-00Z-orchestrate-20261126-teams.json` (final verdicts, three agent entries, `open_items`).

No source, test or configuration file changed, so I reused my round-2 test runs and did not run anything again:
- projects-api: 1500 pass.
- meetings-api `src/hosts`: 96 pass.
- `tsc` on both services: clean.
- projects-ui: 1101 pass plus 2 expected-fail.
- admin-ui: 1184 pass.
- The two red gates outside the feature are unchanged (hours-api `env.test.ts`, env-doctor `push.test.ts`).

QE's latest verdict is PASS (round 2, at `68c59172`). It is not BLOCKED.

| Dimension | Weight | Score (/5) | Floor | Weighted | Evidence |
|---|---|---|---|---|---|
| AC satisfaction | 35 | 4 | 4 | 28.0 | No change. 31/31 ACs are traced to executed tests (qe-report AC table) and backed by real-browser journeys. Evidence is still thin for three: AC-5.3 has integration tests only (`meeting-host.test.ts`), AC-5.4's banner is shown in jsdom only, and AC-5.6's recovery is shown with a fake clock only (`teams.pageLimit.test.ts`). |
| Spec fidelity | 20 | 4 | 3 | 16.0 | Two of round 2's three drifts are closed. design.md:352 now states the "tu" rule that shipped and cites decisions.md:178. The ADR's § Evidence (lines 119-129) now names tests that exist; I opened each one and each pins its claim, including the malformed `assignees` case at `activities-api/src/hosts/client.test.ts:359` and `null` → 503 at `assignable.test.ts:61`. tasks.md records the fix rounds. One drift remains: the AC-11.10 surface guard of specs/20261104-meetings was loosened for one constant (`meetings-api/src/hosts/client.test.ts:34-45`). It is harmless and recorded, but it is a "trivial addition", which is the 4 anchor. |
| Test quality | 20 | 4 | 3 | 16.0 | No change, since no tests changed. For: the cross-package budget test refuses to skip, and QE saw 8 mutations go red. Against 5: the hostile-input (NUL) tests came only after QE found D1, no e2e assertion was ever seen red, and the D16 bounds use real timers. |
| Code quality | 15 | 5 | 3 | 15.0 | No change. D16 races one timer per call and clears it in `finally`; flights are never aborted, and `readIds` never rejects (`projects-api/src/lib/teams.ts:309-328,427-452`). No new dependency. R12, R13 and D2 remain residuals outside the anchor. |
| Design fidelity | 15 | 4 | 3 | 12.0 | Much closer than in round 2. I compared every Italian row of design.md § Copy (lines 360-604) with `admin-ui/src/strings/teams.ts`, `projects-ui/src/strings/project.ts`, `projects.ts` and `tasks.ts`, and they now match, `countOf`'s singular included. The badge note (192-194) matches `AttachedTeams.tsx:14,63-66`. The residual gaps keep it at 4, not 5: the Copy block still lacks `team.teams.dialog.unnamed`, `projects.list.teamUnreadable` and admin-ui `detail.loading`, which have English in the prose (287, 295, 133) but no Italian anywhere in design.md; design says "Loading…" (133), but the code says "Loading the team…" (`teams.ts:59`); and the unavailable banner and its Retry focus are still verified in jsdom only. |
| Trajectory | 10 | 4 | 2 | 8.0 | The trace now records the designer and adr-writer passes that round 2 asked for, and git agrees: `d42f1f7e` is the docs commit. The round-2 deductions stand: the trace is `reconstructed: true`, the security review's round-0 timing is the author's claim, T12 ran `db:deploy` on the dev DB, and frontend-dev made the register decision alone (the designer reconciled design.md afterwards, not before). New, minor: `04450b94` writes `verdicts.eval: "PASS"` and `result: "completed"` before this re-evaluation existed. It reflects round 2's verdict, but it is a verdict entered ahead of the evaluation the done gate asked for. |
| **Total** | 115 | | | **95.0 / 115 = 82.6/100** | |

**Verdict: PASS.** The total is 82.6, at or above `pass_score` 80, and every dimension is at or above its floor. The score is the same
as round 2's. The documentation commits closed findings that sat inside dimensions already at 4, but none of them reaches a 5 anchor.

## Findings

### AC satisfaction (4)

Unchanged. To reach 5, two pieces of browser evidence are missing:
- a meetings e2e in which a person reads a linked meeting through an attached team only (AC-5.3);
- an e2e way to make the team read fail, so the AC-5.4 banner and the AC-5.6 recovery are seen in a browser. That would be a stub in
  front of auth in the e2e stack, never a production switch.

### Spec fidelity (4)

- **Closed this round:**
  - The design rule against the shipped register is reconciled (design.md:352).
  - The ADR's § Evidence is current and accurate.
  - tasks.md is re-synced to the plan amendments D1 and D16.
- **Open:** the loosened guard of another spec, AC-11.10 in `meetings-api/src/hosts/client.test.ts`. It still proves that the only
  exported functions are `resolve` and `sendNotice`, and it pins the literal. To reach 5, record the allowance in specs/20261104-meetings
  (an amendment note to AC-11.10), or move the constant to a module the guard does not cover.

### Test quality (4)

Unchanged; see round 2. To reach 5:
- a hostile-text case for every free-text input written as part of the feature's own tests;
- at least one e2e assertion shown to fail under a mutation;
- the D16 bounds driven by a controllable clock instead of wall time.

### Code quality (5)

Unchanged. The residuals are not deductions:
- **R12:** per-process limiters, with projects-api pinned to one replica.
- **R13:** projects-api's cold permission check has a 5 s budget, and the chained hours-api → activities-api 2 s has no margin.
- **D2:** NUL gives a 500 on routes that existed before this feature.

### Design fidelity (4)

- **Closed this round:**
  - The register rule and all Italian copy rows now match the strings that shipped.
  - The badge note matches the code and cites its reason (decisions.md T15).
- **Open, which is what keeps it at 4:**
  - Three shipped keys are not in the Copy block, so their Italian is in no design artefact:
    - `project.team.teams.dialog.unnamed`: "Team that could not be loaded" / "Team che non è stato possibile caricare".
    - `projects.list.teamUnreadable`: same text.
    - admin-ui `detail.loading`: "Loading the team…" / "Caricamento del team…".
  - The admin detail page's loading label differs between design ("Loading…", line 133) and code.
  - The unavailable banner's Retry focus rule is verified in jsdom only (qe O-2), and no browser journey renders projects-ui in Italian.

  To reach 5, add the three keys to the Copy block and align line 133 (owner: designer). A browser check of the unavailable banner
  would remove the last evidence gap.

### Trajectory (4)

The trace and git agree on every agent and its order. QE ran three times, and the round-2 docs items were done by the agents they were
routed to. These keep it from 5:
- the trace was reconstructed after the fact;
- the security review's timing is self-reported;
- T12 applied a migration to the dev DB, against the owner's test-DB rule;
- the register decision was made without the designer;
- the trace stated the eval verdict before this re-evaluation.

## Recommended next step

PASS. The spec may move to `done` (`/wellforge:done 20261126-teams`), treating the two red gates below as pre-existing.

Open items, none gating this feature:

| Item | Owner |
|---|---|
| Add `team.teams.dialog.unnamed`, `projects.list.teamUnreadable` and admin-ui `detail.loading` (en + it) to design.md § Copy; align the detail loading label at line 133 | designer |
| Record AC-11.10's one-constant allowance in specs/20261104-meetings, or move the constant out of `src/hosts/client.ts` | spec owner / backend-dev |
| D2: NUL → 500 on pre-existing routes (`GET /projects?q=`, auth departments, `GET /admin/users?q=`), one choke point per service | backend-dev, as a separate bugfix |
| R12: a guard or startup assertion for the single-replica limiters, if wanted | architect |
| R13: projects-api cold permission check 5 s; hours-api → activities-api 2 s nesting | architect, for the host-contract services |
| Red gate: env-doctor `push.test.ts` expects `PUSH_ENABLED=false`, but the production template has said `true` since 2026-11-13 | owner or devops |
| Red gate: hours-api `src/lib/env.test.ts` (2 fail) after `08758806` removed `DATABASE_URL` from `.env.example` | owner (their commit) |

---

## Round notes

- **Round 1** (`819fb62f`): FAIL 76.5. Scores were AC 4, spec 4, tests 4, code 4, design 4 and trajectory 2. There was no run trace and
  no committed OWASP artifact. The 5 s team read sat inside the callers' 2 s deadline, with no test relating them. The Italian register
  was mixed inside one banner.
- **Round 2** (`99183a06`): PASS 82.6. The trace, the security review, plan D16 and the register fix raised code quality to 5 and
  trajectory to 4. Design fidelity stayed at 4 because design.md was left stale. The ADR Evidence was stale too.
- **Round 3** (this report, at `04450b94`): PASS 82.6. Only documentation changed. design.md, the ADR Evidence and tasks.md are now
  aligned with what shipped, apart from three copy keys and one loading label. No dimension crosses an anchor, so the scores are
  unchanged. Test runs were reused from round 2, since no code changed.
