---
spec: 021
evaluated: 2026-11-05
rubric: default-v2
score: 80.0
verdict: PASS
round: 3
---
# Eval report: Meetings — record, transcribe, summarise and question meetings (re-eval, round 3)

**History.** Round 1: FAIL 73.0. Round 2: FAIL 76.5 (`spec_fidelity` 3 over the AC-3.2 edge; design S1
E-filtered without Clear filters). Round 3 (this one): **PASS 80.0**, exactly at the threshold, with no margin.

**Rubric.** `/Users/matteocodogno/.claude/plugins/cache/wellforge/wellforge/2.56.0/config/eval-rubric.yml`
(`version: default-v2`). This is the plugin's bundled copy; the repo has no `gates/` and no `.wellforge-gates/`.
There is no `specs/021-meetings/eval.md`, so no overrides apply. `design.md` exists, so `design_fidelity` applies
and the weight pool is 115.

**What I checked myself on `feat/021-meetings` @ d32838c** (37 commits since 3b3c61f). No score was carried forward.
- meetings-api suites that need no database: `bun test src/lib/google src/lib/startupChecks.test.ts src/lib/env.test.ts
  src/lib/residency.test.ts src/ai src/media evals`. Every Google, startup-check, env, residency, AI, splitter and eval
  test passes. The 54 failures are all database-backed files (`rateLimit`, `normalize`, `prepareAudio`), which fail
  at Prisma authentication. The real-ffmpeg suites skip: there is no ffmpeg on the host.
- `bun run typecheck`: exit 0. `bun run eval` (fake model): PASS, still with "157 prose-only residual (only a live
  run shows the model resisting)".
- meetings-ui: **900/900 tests pass**; `pnpm lint && pnpm build` exit 0. `bash -n infra/meetings-gcs-transient-policy.sh` OK.
- **Not reproduced.** The DB integration suite (1534 tests) could not run here because the local Postgres
  container has no `postgres` role. I also did not reproduce the e2e or the containerised real-ffmpeg run. For those
  I rely on the QE PASS recorded in `.forge/runs/2026-11-05T09-00-00Z-orchestrate-021-meetings.json`.
- **External APIs.** `@anthropic-ai/vertex-sdk` 1.1.2 accepts the `baseURL`, `region`, `projectId`, `authClient`
  options that `vertexClaude.ts:76-84` passes (`node_modules/@anthropic-ai/vertex-sdk/client.d.ts:8-9,39`).
  Nothing in the Google path has been observed against a real Google endpoint.
- **Spec 022 has no effect on 021.** Commit 6290d43 touches only `specs/022-meetings-live/spec.md` and
  `.claude/context/glossary.md`. No 021 artifact or code changed, so it is not weighed here.

| Dimension | Weight | Score (/5) | Floor | Weighted | Evidence |
|---|---|---|---|---|---|
| AC satisfaction | 35 | 4 | 4 | 28.0 | **AC-3.2 edge (round-2 blocker) closed.** An uploaded file that decodes past 3 h now deletes the original and returns the meeting to `draft` with `failureCode=too_long`, and the creator is notified. See `meetings-api/src/jobs/handlers/prepareAudio.ts:175-192,279-288`. Nine cases cover it in `prepareAudio.refuse.test.ts:63-187`: draft + reason, metadata kept, a fresh mint works, a delete failure is not hidden, a stale attempt never deletes a newer upload, recorded sources unchanged. The UI names the reason (`UploadCard.tsx:261`, plus a test). <br>**New and changed ACs.** <br>• AC-4.1: notice version `2026-11-05` server-side (`consent.routes.ts:28`); disclosure in en/it (`strings/consent.ts:18,46`). <br>• AC-4.12 / 4.5 / 4.6: the transient prefix is deleted before any DB change, and 503 means nothing was deleted (`delete.routes.ts:94-96`, `delete.test.ts:104,153`). Attempt-scoped cleanup is in `googleSpeech.ts:351,411` and tested at `googleSpeech.test.ts:354-403`. <br>• AC-4.9: N2/N3/N4 refuse on every property, and unreadable counts as a refusal (`startupChecks.ts:101-124,202-242`). <br>• AC-6.2 parts: `googleSpeech.ts:129-191`, `TranscriptView.tsx:136-228`. <br>**At the floor because evidence is thin for a cluster,** all of one kind (a real third party never observed): <br>• AC-7.12 / 9.7: no `--live` run; <br>• AC-2.2 / 2.4 / 2.5: the e2e microphone is stubbed and tab audio only uses fake tracks; <br>• AC-6.1 / 6.2 / 6.5 on Chirp 3 and AC-4.9 N3/N4 on Vertex's control plane: only hand-built fixtures (`test-fixtures/google-speech/README.md`). Plan R2 itself says Google's page "contradicts itself on diarization … and on word timestamps". <br>That is more than the anchor's "one or two". I keep 4 because every AC's own contract is tested and the external observation is an explicit, open release gate (T107, then T92). A T107 outcome that contradicts the fixtures (for example, no `speakerLabel` without word offsets) would drop this to 3, which is below the floor. |
| Spec fidelity / no drift | 20 | 4 | 3 | 16.0 | The round-2 drift is gone: the AC-3.2 fix follows the user's option 1 (trace drift event 1, resolved). The provider switch went spec-first: <br>• plan § Amendment G-0..G-17, approved by the user (`plan.md:1459-1463`); <br>• spec A5/A6 with the body updated (`spec.md:50-67,119-135`, AC-4.1, AC-4.6, AC-4.12, AC-6.2); <br>• ADR-0069/0070; tasks T95–T112 re-synced (`tasks.md:612`). <br>Implementation matches G-1/G-2/G-3/G-4: REST plus the explicit SDK client, `chirp_3` with one locale, `gcsOutputConfig`, per-part `p<n>:` keys, never `global`. The Azure and Bedrock code is gone (`git grep -i "azure\|bedrock" meetings-api/src package.json` is empty). The one contract drift, the G-11 Transcriber `context` parameter, is recorded and resolved. Not 5: <br>• AC-3.2's "refused before processing" is met in effect, not literally: the meeting enters `processing`, then reverts. Harmless and noted in ADR-0064. <br>• An upload that is `audio_unreadable` at decode still ends `failed`. Type and track are checked at confirm, so this is acceptable. <br>• **T104 is ticked although its done-when ("the PR job is green on the branch; a dispatched run without the vars fails") cannot have been met.** The branch has no upstream and there are no GitHub runs. |
| Test quality | 20 | 4 | 3 | 16.0 | Strong, adversarial unit coverage of the new code: <br>• Speech, `googleSpeech.test.ts:154-494`: the request body, poll backoff and deadline, every G-8 row, one part failing fails the whole attempt, a stale attempt never touches a newer prefix, cleanup failure does not mask the outcome, log/message privacy, shape refusal; <br>• N2/N3/N4: one refusal per property; <br>• deletion ordering with a failing fake (`delete.test.ts:104-170`); <br>• the AC-3.2 race cases listed above; <br>• QE's red axe test (7d7b376) before the divider fix (5bbdb44); <br>• the policy-script harness with a fake `gcloud` (`infra/meetings-gcs-transient-policy.test.sh`). <br>Gaps, and they do weigh: <br>• the Speech adapter is proven only against **hand-built** fixtures, so the tests prove the code matches the team's reading of Google's REST reference, not Google; <br>• `split.real.test.ts:15` is `skipIf(!hasFfmpeg)` and runs in no CI job; <br>• `--live` has never run; <br>• the e2e microphone is stubbed; <br>• there is no test for a cross-job same-attempt key collision (see code quality). <br>Open T107 is the right place to close the fixture gap; until then this cannot be 5. |
| Code quality & conventions | 15 | 4 | 3 | 12.0 | Idiomatic and fail-closed. Every SDK default is overridden on purpose (`vertexClaude.ts:73-85`), with a defence-in-depth location re-check (`:75`). Failures map to closed codes by status only, never provider text (`googleSpeech.ts:93-103`). Output reads are bounded and prefix-checked (`:311-320`). N4 passes only on a 404 or a body it fully understands (`startupChecks.ts:182-196`). The ffmpeg slot replaces kind exclusion (T98). Startup messages carry no values. Not 5: <br>• N3/N4 hosts and shapes on `aiplatform.eu.rep.googleapis.com` are unconfirmed (security L2). This fails closed, so it is a deploy risk, not a leak. <br>• A user retry of `transcribe` is a new job that restarts at attempt 1. A leftover from an older job's same attempt number makes the `ifGenerationMatch=0` upload answer 412, which maps to permanent `provider_rejected` (`transientStorage.ts:139`, `auth.ts:40`). It recovers on the next retry and the 1-day rule bounds it (security L4), but it is a spurious failure. <br>• Transient cleanup failure is log-only (`googleSpeech.ts:411`), by design. |
| Design fidelity (UI) | 15 | 4 | 3 | 12.0 | The round-2 gap is fixed: the E-filtered `StatePanel` now carries Clear filters, and focus returns to the search field (`MeetingsListPage.tsx:130-136,185-197`; design `design.md:255-256`), with a test. The new UI is built to plan G-3 "What the UI shows": <br>• an info `Banner` plus per-part dividers, with the list-semantics fix after the axe failure (`TranscriptView.tsx:179-228`); <br>• the upload-refused warning `Banner` (`UploadCard.tsx:261`); <br>• the en/it consent statement. <br>Not 5: **`design.md` was not updated in this round** (no commit since 3b3c61f). The consent string table still lists `statements[5]` (`design.md:584`) where there are now 6. The transcript-parts banner and dividers and the draft "upload refused" state are not designed there. The design chain now lives partly in plan.md. |
| Trajectory | 10 | 4 | 2 | 8.0 | The trace (wellforge-run/v3) shows a coherent order: <br>1. the AC-3.2 / T55 / ADR fixes, then owasp PASS WITH NOTES and QE PASS; <br>2. architect plan amendment, then PO spec A5/A6 (user-approved), with drift events resolved; <br>3. backend, frontend and devops lanes in worktrees (ids `a99d8bd561bfedc20`, `afdadc5d0552126b5`, `ae424f573c2ef07d9` all appear in the local session logs); <br>4. owasp REVIEW REQUIRED (N4 medium) and QE FAIL (D1 a11y, D2 e2e), then fix commits (ccca3c3, 5bbdb44, 37011b0, e77a16b, 2345855, 92af5b1), then owasp PASS WITH NOTES and QE PASS. <br>Commit timestamps match this order. Not 5: <br>• `finished`, `rigor_recorded` and `tokens` are null, and `result` is "partial"; <br>• `verdicts.security` says "PASS" where the agent said PASS WITH NOTES; <br>• the main backend lane records no commits; <br>• QE fixed D2 itself (93816f7) instead of routing it to a dev; <br>• T104 was ticked without its CI evidence; <br>• T107 and T92 are open (expected). |
| **Total** | 115 | | | **92.0 / 115 = 80.0 / 100** | |

**Verdict: PASS.** The total of 80.0 meets `pass_score` 80 with zero margin. No dimension is below its floor;
`ac_satisfaction` sits exactly at its floor of 4.

## Findings

- **Why it passes now.** The round-2 blocker (AC-3.2 edge) is fixed with real tests, and the design gap
  (E-filtered Clear filters) is closed. The provider switch is large: about 8 k lines across 108 files. It was done
  spec-first with user approval, is well tested at the unit level, and introduces no contract drift that was not
  recorded. Spec 022 does not affect 021.
- **T107 and the hand-built fixtures (asked explicitly).**
  - They weigh on `test_quality`: it holds 4, not 5, because the Speech adapter is verified only against the team's
    reading of Google's REST reference.
  - They weigh on `ac_satisfaction`: it sits at its floor because AC-6.1, 6.2, 6.5 and 4.9 (N3/N4) have no
    observed real-provider behaviour.
  - They do not sink the eval. T107 is an approved, explicit release gate, plan G-12 places it "outside the AC
    mapping", and T92 depends on it, so nothing claims the feature is done.
  - **This PASS does not cover release.** If T107 shows that Chirp 3 batch returns no `speakerLabel` without word
    offsets, or that the N3/N4 shapes or hosts differ, `ac_satisfaction` falls below its floor and the feature
    must be re-evaluated.
- **T104 ticked without its done-when.** The branch is not pushed and there is no GitHub run. Either push it and
  record the PR job plus a dispatched run without vars, or untick T104.
- **design.md is stale for this round.** Update it with `statements[6]`, the transcript-parts banner and dividers,
  and the draft upload-refused state, so the design chain stays complete.
- **Cross-job transient key collision.** A user retry after a crashed last attempt can get a 412, reported as
  `provider_rejected`. Consider treating 412 on `put` as "delete that key and retry", or keying the prefix by job
  id as well as attempt.
- **Still open from earlier rounds (release items, not scored again):**
  - a green `--live` eval (AC-7.12 / 9.7);
  - a real-Chromium microphone and tab-share check (AC-2.2 / 2.4 / 2.5);
  - real-ffmpeg suites in CI.
- **Accepted security notes:** L1–L4, and H1/H4 as sign-offs (O13).

## Recommended next step

- PASS, so the eval gate is satisfied. Do **not** move the spec to `done` yet: T107 (the Google spike in a sandbox
  project) and then T92 must close first, as `tasks.md` requires.
- Re-run `/wellforge:eval` after T107 swaps the recorded fixtures in and sets `PIECE_MAX_MS` and word offsets,
  because those can change the AC-6.2 evidence. Fix T104's evidence and the `design.md` sync in the same pass.
