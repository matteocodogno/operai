---
spec: 021
evaluated: 2026-11-05
rubric: default-v2
score: 76.5
verdict: FAIL
round: 2
---
# Eval report: Meetings — record, transcribe, summarise and question meetings (re-eval, round 2)

**Rubric.** `/Users/matteocodogno/.claude/plugins/cache/wellforge/wellforge/2.56.0/config/eval-rubric.yml`
(`version: default-v2`). This is the plugin's bundled copy; the repo has no `gates/` and no
`.wellforge-gates/`. There is no `specs/021-meetings/eval.md`, so no overrides apply.
`design.md` exists, so `design_fidelity` applies and the weight pool is 115.

**Re-checked independently on `feat/021-meetings` @ 58cbae4.** No score was carried forward from round 1.
- meetings-api `bun test` against a local `meetings_test` DB: **1299 pass / 27 skip / 0 fail**
  (1326 tests). The skips are the real-ffmpeg suites; there is no ffmpeg on the host.
- meetings-ui: **881 / 881 pass**.
- `bun run eval` (fake model): 53/53 fixtures pass, still with "157 prose-only residual (only a
  live run shows the model resisting)".
- In the local `operai-ffmpeg-local` image I confirmed the premise of the 8666836 revert:
  - a `-live 1` WebM/Opus probes with **no `format.duration`**;
  - `-t` truncates the decode (a 30 s input with `-t 5` gives 5.01 s of output).
- I did **not** reproduce the containerised 108/108 real-ffmpeg run, e2e, or the other apps'
  suites. Those figures come from the QE record.
- The run trace `.forge/runs/2026-11-04T00-00-00Z-orchestrate-021-meetings.json` was read in
  full. I checked its worktree ids (e.g. `afed7159ba82da6b4`, `af842dbc2aceb9d7f`,
  `a6add0e34696ca88c`) against the local Claude session logs, and they appear there.

| Dimension | Weight | Score (/5) | Floor | Weighted | Evidence |
|---|---|---|---|---|---|
| AC satisfaction | 35 | 4 | 4 | 28.0 | 123/123 ACs are mapped, and the core ACs have strong evidence:<br>• visibility/roles: assembled-route matrix plus byte-identical 404 (`meetings-api/src/matrix.test.ts`);<br>• auth outage: `authz-outage.test.ts`;<br>• AC-2.8: `derived.test.ts` A1 cases plus the real-timing e2e `shell/e2e/meetings-capture.spec.ts:146`;<br>• AC-3.1, now fixed for browser WebM: `upload.integrity.test.ts:152,235,254` and `prepare.real.test.ts` "a browser-saved WebM/Opus upload with NO duration header is accepted".<br>Evidence is thin or partial for:<br>• AC-7.12 and AC-9.7: the model half has never been observed;<br>• AC-2.4 and AC-2.5: real tab audio never captured;<br>• AC-2.2: the e2e **replaces `getUserMedia`** with a WebAudio tone (`shell/e2e/helpers/meetingsFixtures.ts:363-388`), so the browser's own microphone request and grant are never exercised end to end;<br>• AC-3.2 has a new edge (see spec fidelity). |
| Spec fidelity / no drift | 20 | 3 | 3 | 12.0 | The round-1 drift (every upload without a stated duration refused) is reverted: 8666836, `media/probe.ts` `judgeProbe` no longer has `requireDuration`. The revert leaves one edge at odds with AC-3.2, and neither the spec nor the plan records it: <br>• AC-3.2 says a file "over the … duration limit" is "refused **before processing** … and the meeting stays `draft`". <br>• A file with no stated duration that is longer than 3 h is now accepted at confirm and enters `processing`. The decode cap then raises `too_long`, and `prepareAudio.ts:226-231` calls `markFailed`, which sets the meeting to **`failed`**, not `draft`. <br>• Because the source is now locked (AC-3.5/G1), the creator cannot upload a shorter file to the same meeting; retrying (AC-6.9) re-runs the same cap. <br>• ADR-0064 round 3 says only "refused as `too_long`". No test asserts the meeting's final state in this case. <br>Doc nits: ADR-0064 round 3 cites commit `e06292b`, which is on no branch (the fix is 8666836); ADR-0061:38-39 still says "the region's" retention while the code checks every destination Region. The other changes (G1–G9, T94 and T19–T34 amendments, `host_reader`) are recorded in the plan. |
| Test quality | 20 | 4 | 3 | 16.0 | Strengths: the route-table matrix; the stranger-vs-missing byte compare; the negative-control evals (`evals/eval.test.ts:67,74,85`); real-ffmpeg bomb and cap tests (`media/normalize.real.test.ts:49-108`) plus the new duration-less WebM real test; e2e with real timings. Gaps: <br>• the e2e microphone is a stubbed `getUserMedia`; <br>• tab audio is tested only with fake tracks (`capture/mixer.test.ts:156-213`); <br>• Azure Speech and Bedrock are only ever stubbed, and the R2 latency spike has no task; <br>• the real-ffmpeg suites run in no CI job; <br>• the mov `dref` case is untested; <br>• `--live` has never run; <br>• the new AC-3.2 edge (duration-less upload longer than 3 h, end state) has no test. |
| Code quality & conventions | 15 | 4 | 3 | 12.0 | The code is idiomatic and fails closed: `auth/guards.ts`, `meetings/visibility.ts` `assertCreatorControl` (503 on an identity outage), the advisory-locked rate limiter `ai/rateLimit.ts:54-74`, and the server-owned output shape `ai/prompts/summary.ts`. I checked that the SDK APIs it calls exist (`GetAccountDataRetentionCommand` with `mode` "none", `GetInferenceProfileCommand`, `ConverseCommand`). The live gate is fixed in 9883e44: `meetings-eval-live.yml` now exits 1 on `workflow_dispatch` when unconfigured and skips only on `schedule`. Not 5: <br>• the upload `too_long` path makes the meeting `failed` with a retry that cannot succeed; <br>• open security residuals: the mint is not row-locked, there is no cap on container runs per recording, and the stored key stays writable until the policy expires. |
| Design fidelity (UI) | 15 | 4 | 3 | 12.0 | `design.md` is complete: 17 flows; per-screen L/E/F/403/404/503 states; an a11y plan; reuse mapped. The build realises it, for example: <br>• focus moves to Pause on start and to the saving container on stop, and the timer is `role="timer"` (`components/meeting/RecordingPanel.tsx:190,354-357,425,462`); <br>• `aria-disabled` with the reason via `aria-describedby` (`SummariesPanel.tsx:92-93`); <br>• the four new library parts have stories, and the axe e2e passes. <br>One state diverges: design S1 **E-filtered** is "`StatePanel` 'No meetings match' + … **Clear filters** action". `pages/MeetingsListPage.tsx:184-186` renders that StatePanel without an action, although `StatePanel` supports `action`; Clear filters exists only in the filter card (`:271`). |
| Trajectory | 10 | 4 | 2 | 8.0 | The trace (wellforge-run/v3) shows the expected sequence: product-owner → architect → adr-writer → designer → 34 dev/devops lanes in worktrees, in dependency order → T83 evals by QE (which found DEF-1..3) → e2e by QE → owasp-reviewer FAIL → FAIL → PASS-with-notes → QE FAIL → PASS → evaluator FAIL 73. It also records 6 drift events, 2 collisions and 5 env faults. Worktree ids are corroborated by the session logs. Not 5: <br>• the trace was written after the fact (committed in 58cbae4 after eval round 1, `started` is a placeholder `00:00:00Z`, `finished` and `rigor_recorded` are null); <br>• the evaluator drift event is still `resolved:false`; <br>• the collisions show `touch:` lists missing a shared test file; <br>• T84's GitHub run and T92 are not done. |
| **Total** | 115 | | | **88.0 / 115 = 76.5 / 100** | |

**Verdict: FAIL.** The total of 76.5 is below the `pass_score` of 80. No dimension is below its floor; `ac_satisfaction` and `spec_fidelity` sit exactly at theirs.

## Findings

- **What changed since round 1.**
  - The trace makes trajectory scorable: 2 → 4.
  - The upload-duration revert and the live-gate fix are real and verified.
  - The revert opened one new AC-3.2 edge, and that keeps `spec_fidelity` at 3. It is the only thing between this feature and a pass: at `spec_fidelity` 4 the total is exactly **80.0**.
- **AC-3.2 edge (spec fidelity, test gap).**
  - An upload with no stated duration that decodes past 3 h + 60 s ends `failed` / `too_long` after it enters `processing`. AC-3.2 requires the meeting to stay `draft`.
  - The source is locked, so the only way out is deleting the meeting.
  - To raise it, either:
    - on an **upload's** `too_long` (or `audio_unreadable`) in `prepare_audio`, delete the original and return the meeting to `draft` with the reason, so it behaves as if refused at confirm; add a test asserting `status: "draft"` and that `can.changeSource` is restored; or
    - amend AC-3.2 (spec first, per AGENTS.md) to say that a file of unstated length found too long while decoding ends `failed` with the reason, and add a test for that end state.
- **AC-7.12 / AC-9.7.**
  - Proved: the server enforces the template's shape and cleans the prose (fake-model evals with a negative control).
  - Unproved: that the real model treats injected sentences as quoted content. No `--live` run exists.
  - The gate now fails closed on dispatch, but it still has to actually run green before release, as the README now requires.
- **AC-2.2 / 2.4 / 2.5 capture.**
  - The e2e stubs `getUserMedia` (env fault "Chromium fake mic never answers in this macOS sandbox", recorded in the trace).
  - The tab-share path is covered only by unit tests with fake tracks.
  - Both need a real-browser check before release.
- **Design S1 E-filtered** is missing its Clear filters action (`MeetingsListPage.tsx:184-186`).
- **Docs:** ADR-0064 round 3 cites a commit (`e06292b`) that is not in history. ADR-0061 still describes the retention check as single-region.
- **Security notes still open (low or accepted):**
  - access through a residual JWT after deactivation;
  - no transcription or upload quota;
  - the directory is readable by all employees (ADR-0066);
  - 15-minute playback URL;
  - mint not row-locked;
  - no cap on container runs;
  - padding at the exact 3 h boundary;
  - real-ffmpeg suites not in CI;
  - live-eval environment protection is a repo setting.
- **Rest-of-suite e2e:** the coordinator's attribution (the 6 EstimAI/notifications specs fail on both trees; the 3 others fail identically with main's shell) is consistent with the trace. I did not reproduce it.

## Recommended next step

FAIL. This was round 2 of 2, so it goes back to the orchestrator and owner. The smallest change that would honestly earn a pass is the AC-3.2 edge fix and its test, through `/wellforge:implement` on T28/T30. That lifts `spec_fidelity` to 4 and the total to 80.0, a pass at the threshold.

Adding the E-filtered Clear filters action (design → 5) would give margin: 82.6.

Independently of the verdict, record a `--live` eval run and a real Chromium tab-share check before release.
