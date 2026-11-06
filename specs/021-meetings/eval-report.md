---
spec: 021
evaluated: 2026-11-05
rubric: default-v2
score: 80.0
verdict: PASS
round: 4
---
# Eval report: Meetings — record, transcribe, summarise and question meetings (re-eval, round 4)

**History.** Round 1: FAIL 73.0. Round 2: FAIL 76.5 (`spec_fidelity` 3 over the AC-3.2 edge; design S1
E-filtered without Clear filters). Round 3: PASS 80.0 at d32838c (zero margin). Round 4 (this one, b8d8245, after
T107 spike, spec A7/A8, plan amendment #2 H-0..H-14, T113–T124/T126/T127): **PASS 80.0**, again with zero margin.

**Rubric.** `/Users/matteocodogno/.claude/plugins/cache/wellforge/wellforge/2.56.0/config/eval-rubric.yml`
(`version: default-v2`), the plugin's bundled copy; the repo has no `gates/` and no `.wellforge-gates/`. No
`specs/021-meetings/eval.md`, so no overrides. `design.md` exists, so `design_fidelity` applies (weight pool 115).

**What I ran myself on `feat/021-meetings` @ b8d8245** (45 commits since 6a83224, 128 files, +15 089/−848). No
score was carried forward.
- meetings-api, the suites with no database: `bun test src/ai/stitch.test.ts src/ai/stitch.recorded.test.ts
  src/ai/completeness.test.ts src/ai/googleSpeech.test.ts src/ai/vertexClaude.test.ts src/ai/words.test.ts
  src/ai/segments.test.ts`: **260 pass, 0 fail**. The wider set (`src/ai src/lib/google startupChecks env residency
  src/media evals`): 639 pass, 30 skip, 54 fail. All 54 failures come from Prisma `P1000` in `captureKit.ts:68 resetDb`
  (in `rateLimit`, `normalize`, `prepareAudio`). This is the same local-DB limitation as round 3, not a code failure.
  `bun run typecheck`: exit 0.
- meetings-ui: **955/955 tests pass** (900 in round 3); `pnpm lint`: exit 0; `pnpm build`: exit 0. operai-ui: 142/142.
- **Not reproduced:** the DB integration suite, e2e, containerised real-ffmpeg, and the two `--live` evals (T121).
  For these I rely on the run trace `.forge/runs/2026-11-05T09-00-00Z-orchestrate-021-meetings.json` (QE PASS after
  2 rounds, owasp PASS WITH NOTES).

| Dimension | Weight | Score (/5) | Floor | Weighted | Evidence |
|---|---|---|---|---|---|
| AC satisfaction | 35 | 4 | 4 | 28.0 | **Better than round 3, still 4.** The real third party has now been observed: <br>• T107 spike on Chirp 3 `eu` (≈6.3 h of synthetic it/en audio), recorded and scrubbed into fixtures (`test-fixtures/google-speech/README.md`, `plan.md:1667`). "N2–N4 pass on the sandbox" (`plan.md:1667` item 5) closes round 3's AC-4.9 N3/N4 gap. <br>• T121 live eval ×2 PASS (trace agent row "live eval x2 on claude-sonnet-5-5"; `ac3b3b5`). <br>**New A7/A8 ACs are implemented and tested:** <br>• AC-6.11, retry bound 0: `googleSpeech.ts:107` `MAX_TRIES = 1`; `completeness.test.ts:114,187` "a repetition never makes it incomplete". <br>• AC-6.12 gap detection and ranges: `completeness.test.ts:38-110,305-365`, including the 19.9 s / 20 s edge and the merge across a part boundary. <br>• AC-6.13 duplicates: `completeness.test.ts:127-258` (within a part, same speaker, untimed tail) and `stitch.test.ts:104-145`. <br>• AC-6.14/6.15 joins: `stitch.test.ts:160-244`, with real seams in `stitch.recorded.test.ts:72-128`. <br>• AC-6.16 Separate by part, 15 cases including 403/404/409, frozen, auth-down fail-closed and concurrency: `transcript/separate.test.ts:38-185`. <br>• AC-6.17 replay invariance: `stitch.recorded.test.ts:43-70`. <br>• AC-7.9/9.6 acceptance rule, a malformed reply is a failure: `vertexClaude.ts:117-123,148-149`. <br>• AC-7.13/9.9 caveats: `eecc5a6` (summaries, conversation and summarize tests). <br>• Overlap bound 60–120 s, inside the spec's 30 s–2 min: `split.ts:48-50`. <br>**Why not 5:** <br>• AC-2.2/2.4/2.5: the e2e microphone and tab audio are still stubbed. <br>• AC-6.11/6.13/6.14 are observed on **synthetic** audio only. O14/T125 is open, and the spike itself warns "not validated on real meetings" (`plan.md:1667`(3)). <br>• AC-9.x "answers what the meeting contains" is green only because QH-2 was **extended after a run** so that up to 2 over-refusals per run count as availability (`863c141`, `plan.md` QH-2). The user approved this, but it is a relaxed bar. |
| Spec fidelity / no drift | 20 | 4 | 3 | 16.0 | Spec-first throughout: <br>• A7 (`spec.md:77-97`) and A8 (`spec.md:104-118`) were approved before code. <br>• Plan amendment #2 was approved, and tasks were re-synced (`tasks.md:711`). <br>• Drift events are recorded and resolved (trace `drift_events` 5–8). <br>• The implementation matches the bounds: `REPEAT_WORDS 8`, `REPEAT_GAP_MS 2 000` (`completeness.ts:29,31`), `MATCH_WORDS 20` (`stitch.ts:31`), retry 0. <br>• The Vertex unforced single tool follows H-8 (`vertexClaude.ts:15`). <br>• T104 is now correctly **unticked** (`tasks.md:669,713`), which fixes round 3's finding. <br>**Not 5:** <br>• **The A8 "clarification" (`spec.md:113-118`, AC-6.13 overlap clause) was written by the orchestrator "from implementation"**. The trace records it as orchestrator drift ("applied by orchestrator from PO's exact text"), with no user approval. It narrows the user's literal A8(b) ("duplicate removal is same-speaker only") to within a part. The change is defensible: the literal rule contradicts AC-6.13's first sentence and would keep 60–120 s of duplicated speech. But a user decision was re-scoped without the user. <br>• The clarification's exception, "unless each label is joined to a different label", **can never hold** under AC-6.14(b) (see code quality). The spec now carries a clause with no effect. <br>• The build adds a confirmation step to Separate that AC-6.16 does not ask for (`SeparateSpeakerDialog.tsx:1,58`; design.md:740 (c)). <br>• The round-3 divergence (a), where `failure.code` on a draft has no plan contract, is still not in plan.md (`design.md:736`). |
| Test quality | 20 | 4 | 3 | 16.0 | **Round 3's main gap is closed.** Hand-built fixtures were replaced by recorded Google responses (`6a989ee`, `74752bf`). Tests now replay real seams and real defects: <br>• jitter mislabelling that blocks a join (`stitch.recorded.test.ts:83`); <br>• a recorded hole with the J0 refusal (`:93`); <br>• the 3-voice overlap (`:114`); <br>• a 345-word untimed repeated tail (`:131`). <br>The tests are adversarial: <br>• the exact bounds (19.9 s vs 20 s; 2.0 vs 2.5 s; 7 vs 8 words); <br>• 8 000 equal words for performance (`completeness.test.ts:180`); <br>• labels renamed giving the same joins (`stitch.recorded.test.ts:63`); <br>• the static no-voice-feature import check. <br>QE produced red tests before the a11y fix (role=alert, trace QE round 1 D1). <br>**Not 5:** <br>• No e2e covers the new A7/A8 UI. `shell/e2e` is unchanged since 6a83224, and the notice, Separate and caveats are component-tested only. <br>• `split.real`/`normalize.real` still run in no CI job. There is no meetings-api test workflow in `.github/workflows/`. <br>• Two timing-flake fixes in `googleSpeech.test.ts` (`c5913cb`, `f2d812c`) show the suite is load-sensitive. <br>• The `same()` "different roots" path is admitted untestable (`stitch.test.ts:147-149`). <br>• I could not reproduce the DB suite. |
| Code quality & conventions | 15 | 4 | 3 | 12.0 | The code is pure, deterministic and bounded: <br>• total-order sorts, `MAX_SEEDS_PER_GRAM` (`stitch.ts:33`), no logged content (`:23`), labels namespaced per part (`words.ts:23`); <br>• the acceptance rule maps refusals to closed reasons (`vertexClaude.ts:97-149`); <br>• the library `Banner` gained `live` the proper way: story, test and design-system doc (`575e5bd`). <br>**The unreachable branch (asked explicitly):** in `stitch.ts:227`, `same()` returns false only if `join.has(b.label) && rootOf(b.label) !== rootOf(a.label)`. A label is joined only when `row.size === 1` (`:211`), meaning every aligned word of `b.label` was attributed to one `l1`. The aligned pair `(a, b)` itself fed that row (`:196-203`), so `a.label === l1` and the roots are equal. The `kept.push` branch (`:235`) and the `mergeByStart(…, kept)` arm (`:237`) are dead. The test file admits this (`stitch.test.ts:147-149`). Behaviour is safe, because part k's version is always kept, so no speech present in it is lost. But: <br>• **the file header (`stitch.ts:11-13`) still describes the pre-`8b97512` rule** ("same speech only when the overlap JOINED their labels or one has no label"), which contradicts line 227. That is a looks-right hazard for the next maintainer. <br>• `sameSpeaker` is imported and unused (`stitch.ts:28`), left over from `6d87fa7`. <br>Also: <br>• dead copy `transcript.separate.notJoined` (`meetings-ui/src/strings/transcript.ts:54,130`); <br>• the separate route answers 500 instead of 404 on a hard-delete race (security note); <br>• quadratic worst case on adversarial provider output, bounded by caps (security note); <br>• the round-3 cross-job 412 collision still stands (security L4). |
| Design fidelity (UI) | 15 | 4 | 3 | 12.0 | design.md is synced twice, closing round 3's finding: `64b461f` and `faccb5b`/`0971b13`, with `design.md:733-741`. It covers F8/F9/F12, S3b notice, markers, joined indication, Separate dialog, caveat labels, the a11y section and the copy plan. No NEW library component. The build realises it: <br>• the notice is `Banner live="off"` with `aria-label`, an anchor id and a focus target (`TranscriptView.tsx:106,145,264-272`); <br>• the parts banner shows only with `separateLabels` (`:199-200`, AC-6.15); <br>• the refused upload is `live="polite"` (`UploadCard.tsx:261`). <br>**On the "Sync 2026-11-05" divergences (asked explicitly):** <br>• (a) live region: resolved properly. <br>• (b) dead copy: harmless, but it should be deleted, not documented. <br>• (c) the confirmation is an unrequested step. It is designed and defensible because the action is irreversible, but it is drift from AC-6.16. <br>• (d) the hash fallback: fine. <br>• (e) the static summary badge: matches AC-7.13. <br>• Round 3's (a) is still unresolved in plan.md. <br>Not 5 because two rounds of "reported rather than designed around" items are piling up instead of being closed. |
| Trajectory | 10 | 4 | 2 | 8.0 | The trace (wellforge-run/v3) shows a coherent order: <br>1. QE T107 spike, then PO A7 and architect amendment #2; <br>2. backend T113–T119, backend T120, frontend T122/T123 and adr-writer T126 in worktrees; <br>3. QE T121 and T124, then PO A8, then backend `6d87fa7`/`8b97512`; <br>4. owasp PASS WITH NOTES; <br>5. QE FAIL (D1 role=alert, D2 design.md), then frontend `575e5bd`/`a2a3656` and designer `faccb5b`/`0971b13`, then QE PASS. <br>Commit order matches. **Not 5:** <br>• `finished`, `rigor_recorded` and `tokens` are null, and `result` is "partial"; <br>• `verdicts.security` still says "PASS" where the agent said PASS WITH NOTES; <br>• the T113–T119 backend row lists no commits; <br>• QE wrote production adapter code in T107 (`6a989ee`: `googleSpeech.ts`, `split.ts`, `transientStorage.ts`, the last not in T107's touch list) and later verified the same lane; <br>• the A8 clarification was applied by the orchestrator; <br>• QE round 2 confirmed D3 "by reading". |
| **Total** | 115 | | | **92.0 / 115 = 80.0 / 100** | |

**Verdict: PASS.** The total of 80.0 meets `pass_score` 80 with zero margin. No dimension is below its floor;
`ac_satisfaction` sits exactly at its floor of 4.

## Findings

- **Net change since round 3.** The round-3 blockers to a higher score are fixed: real-provider observation (T107),
  recorded fixtures, a green live eval, the design.md sync and T104 honestly unticked. Against that, the round added
  about 15 k lines of subtle new logic (detector, stitcher, joins, Separate, caveats), along with new nits and one
  ungoverned spec edit. No dimension moved, and the margin is still zero.
- **The unreachable "joined to different speakers" branch.** It is dead in code (`stitch.ts:227,235,237`) **and**
  vacuous in the spec (`spec.md` AC-6.13 overlap clause), because AC-6.14(b) makes every aligned word of a joined
  label share its root. It is harmless: part k's version is always kept. Two ways to fix it:
  - (1) Delete the clause and the branch. The rule then reads "in the overlap, aligned passages meeting the
    word/time evidence are the same speech".
  - (2) Keep the code as a guarded safeguard and say so in the spec.

  Either way, fix the stale header comment at `stitch.ts:11-13` and drop the unused `sameSpeaker` import
  (`stitch.ts:28`).
- **A8 clarification without the user.** Have the user confirm `spec.md:113-118` explicitly, ideally together with
  the deletion above, so AC-6.13 is a user decision again.
- **Should open T104 block the close? Yes, and it already does.** T92 lists T104 as a dependency
  (`tasks.md:762-769`), and its done-when ("PR job green; a dispatched run without vars fails") is unprovable until
  the branch is pushed. It does not weigh on this eval: the workflow content is present and fails closed
  (`.github/workflows/meetings-eval-live.yml:20-25,53,72-84`), and the task is now honestly open. Push, run it,
  then tick it.
- **T125 / O14 is a go-live gate, not a close gate** (QH-1, user decision; not among T92's dependencies). That is
  coherent, but "done" ≠ releasable. Every A7/A8 bound (gap 20 s, repeat 8 words / 2 s, match 20 words) is
  validated only on synthetic `say` audio. The release checklist must carry T125. A T125 outcome that changes a
  bound re-opens AC-6.11 to AC-6.14 and requires re-evaluation.
- **QH-2 relaxation.** Over-refusals now share the availability budget (`863c141`). If the live eval regresses, it
  should be investigated, not absorbed by the budget. Track the over-refusal count per run.
- **design.md divergences.** Close round 3's (a) in plan.md (the draft `failure.code` contract). Delete
  `notJoined` copy, or use it. Either get the AC-6.16 confirmation step into the spec or record it as an accepted
  addition.
- **Still open (not scored again):** a real-Chromium mic/tab-share check (AC-2.2/2.4/2.5); real-ffmpeg suites in
  CI; the cross-job 412 transient-key collision (L4); the separate-route 500-on-race.

## Recommended next step

- PASS, so the eval gate is satisfied. Do **not** move the spec to `done` until T104 has its CI evidence and T92
  runs. T125 stays a go-live gate.
- Cheap fixes before T92 that would buy margin, through `/wellforge:implement`:
  - the `stitch.ts` header comment and unused import, plus the dead-branch/spec-clause decision (T115 lane);
  - the user's confirmation of the A8 clarification;
  - the plan.md contract for the draft `failure.code`;
  - removing the dead `notJoined` copy.
