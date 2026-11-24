# QE report: specs/20261112-meeting-hours (production tier, full mode)

Latest pass only; overwritten on each run. Written by the quality engineer, 2026-11-24. This is the second pass: the first (at
`c3c963b3`) was BLOCKED on one row; this pass re-ran only that row and a regression check after the owner restarted the dev stack,
and kept every other row as measured.

## QE verdict: PASS  (full mode; gates measured at `c3c963b3`, dev-stack e2e re-run at `d04d80ad`)

`d04d80ad` differs from `c3c963b3` only under `specs/` (`git diff --name-only c3c963b3..HEAD | grep -v '^specs/'` prints nothing: the
QE report and its screenshots). The code under test is therefore the code the gates measured, and the gate rows below were not
re-run. Nothing is blocked; nothing is red.

**The previously BLOCKED row is now executed and green.** `shell/e2e/meeting-hours-measured.spec.ts` against the dev meetings-api
(:8085, no `E2E_MEETINGS_API_URL`) passed **5 of 5** after the restart; before it, the same spec on the same code failed 6 of 6. The two
regression specs, `meeting-hours.spec.ts` (3 of 3) and `meeting-hours-moved.spec.ts` (5 of 5), passed on the same restarted stack.
Environment fault EF-1 is closed: it was the stack, not the code. No defect.

| Check | Threshold | Actual | Result |
|---|---|---|---|
| Gates | all green | all 11 rows below green at `c3c963b3`; code unchanged since | ✓ |
| AC coverage | 28/28 | 28/28 have an executed test (table below) | ✓ |
| Defects | 0 | 0 | ✓ |
| Dev stack restarted and clean | one job runner | one `LISTEN meetings_jobs` connection (was four); meetings-api pid 13687 started 15:39:15 | ✓ |
| AC-3.8 / AC-3.9 e2e on the dev stack (design G7, S5) | green, at least 3 runs | 5/5 passed (was 0/6 before the restart) | ✓ |
| Regression after restart: `meeting-hours.spec.ts` | 3/3 | 3 passed (33.9 s) | ✓ |
| Regression after restart: `meeting-hours-moved.spec.ts` | 5/5 | 5 passed (34.9 s) | ✓ |

## This pass: the previously BLOCKED row, re-run (second pass, 2026-11-24 15:39 to 15:42 CET, at `d04d80ad`)

**1. The restart took.** `/health` answered 200 on auth :3001, meetings-api :8085, hours-api :8090, shell :5173, hours-ui :5184 and
meetings-ui :5180. The :8085 listener is pid 13687 (`bun run --hot src/index.ts`, started 15:39:15, child of the `mise run dev` shell
started 15:39:09). Read-only `pg_stat_activity` (`SET default_transaction_read_only = on`, a `SELECT` only, on the compose Postgres :5435):

| Before (first pass) | After (this pass) |
|---|---|
| four `LISTEN meetings_jobs` on `meetings`, started 13:31:09, 14:47:09, 14:51:18, 14:51:18 | **one**: database `meetings`, pid 43897, started 14:39:16, `idle`, query `LISTEN meetings_jobs` |

The server clock is UTC, so `14:39:16` is 15:39:16 CET, one second after pid 13687 started. The count was read again after all eight
e2e runs below: still one, same pid 13687, so nothing restarted or hot-reloaded during the runs. I did not touch the owner's stack.

**2. `meeting-hours-measured.spec.ts` against the dev stack: 5 of 5.** Flags: the eleven `E2E_*_REMOTE_PORT` of the dev ports and
`E2E_SKIP_ACCOUNTING_SEED=1 E2E_SKIP_REFUND_ACCOUNTING_RELEASE=1 E2E_SKIP_LEGAL_ENTITIES_SETUP=1` (the header of `meeting-hours.spec.ts`);
`E2E_MEETINGS_API_URL` and `E2E_SHELL_MEETINGS_API_URL` unset (`env | grep ^E2E_` printed the fourteen flags and neither of those), so
both the API calls and the browser step went to the dev meetings-api. `ffmpeg` and `ffprobe` on the PATH (`/opt/homebrew/bin`).
Command: `cd shell && <those flags> pnpm e2e meeting-hours-measured.spec.ts`, five times in a row (the flags sit in `/tmp/qe-mh-rerun/flags.sh`, local).

| Run | Result | Meeting timeline `(status/stage durationMs)`, first sight of the measured value | Entry minutes |
|---|---|---|---|
| 1 | passed (5.6 s) | `processing/preparing 3600000` x8, then `processing/transcribing 12007`, then `ready 12007` | 60, then 30 |
| 2 | passed (5.3 s) | `processing/preparing 3600000` x8, then `processing/preparing 12007`, then `ready 12007` | 60, then 30 |
| 3 | passed (6.1 s) | `processing/preparing 3600000` x7, then `processing/preparing 12007`, then `ready 12007` | 60, then 30 |
| 4 | passed (4.2 s) | `processing/preparing 3600000` x7, then `processing/preparing 12007`, then `ready 12007` | 60, then 30 |
| 5 | passed (4.5 s) | `processing/preparing 3600000` x6, then `processing/preparing 12007`, `processing/transcribing 12007`, then `ready 12007` | 60, then 30 |

In every run `ffprobe` said the file is 12008 ms and the held sum of pieces 3600000 ms; the corrected value `12007` (within 1 ms of
ffprobe) was first seen while the meeting was still `processing`, 5 of 5 (the first pass saw it in 4 of 5 on the isolated instance).
The spec's own assertions all held: the meeting ends at the measured length and not at the held hour (AC-3.8); `recording.durationMs`
keeps the sum of the stored pieces (A43); the creator's untouched entry goes from 60 to 30 min (AC-3.9); the Details card's Duration line
shows the measured clock value and not `01:00:00` (design S5). Logs: `/tmp/qe-mh-rerun/measured-1.log` to `measured-5.log` (local, not
committed; the timelines above are copied from them).

**3. Regression check on the same restarted stack, once each:**
`meeting-hours.spec.ts` 3 passed (A 19.1 s, B 5.5 s, C 8.3 s; total 33.9 s, AC-1.1, 2.1, 2.3, 2.5, 2.7);
`meeting-hours-moved.spec.ts` 5 passed (A 13.7 s, B 4.3 s, C 5.6 s, D 6.0 s, E 4.3 s; total 34.9 s, AC-2.3 as changed, AC-2.7, D70).
Logs: `/tmp/qe-mh-rerun/meeting-hours.spec.ts.log`, `/tmp/qe-mh-rerun/meeting-hours-moved.spec.ts.log`. The moved spec's screenshots went
to `/tmp/qe-mh-rerun/shots` this time (`E2E_MARK_SHOTS_DIR`), so the committed `qe-evidence/` from the first pass was not touched.

**4. What this does and does not prove.** The spec can fail, and did: 0 of 6 before the restart with four runners, 5 of 5 after with
one, on the same code and the same spec, and the real-ffmpeg test and the isolated-instance runs of the first pass had already shown the
code correct. The whole dev stack was restarted between the red and the green, so the restart is the intervention, and the first pass's isolated-instance
A/B (same auth, hours-api and MinIO, only the meetings-api process differing) is what narrows it to the meetings-api process. Together
they are the support for "EF-1 was the environment". The mechanism (a runner built before the correction landed keeps its old handler table under `bun --hot`) remains
the best-supported explanation and is still not proven by observation of the loaded modules; I did not try to reproduce the accumulation
because that means hot-reloading the owner's meetings-api, which this pass was told not to disturb. The stack had been up about a
minute when run 1 started, so this pass says nothing about how long the dev stack stays correct: the next long-lived `--hot` session
may go stale the same way, which the spec's header already warns about.

## Gates (T14's list, in its order)

All backend runs used an explicit `DATABASE_URL` on a `*_test` database, echoed before each run. `hours_test` and `meetings_test` were
behind by one migration (`20261124093525_meeting_hours`, `20261124100000_hours_notice`), applied with `bun run db:deploy` against those
URLs only. No test, migration or seed touched `hours`, `meetings`, `auth` or any non-`_test` database.

| # | Gate | Threshold | Actual (at `c3c963b3`) | Result |
|---|---|---|---|---|
| 1 | auth: `bun run typecheck && bun test src/system` (`auth_test`) | 0 errors, 0 fail | typecheck OK; 174 pass, 0 fail, 12 files | ✓ |
| 2 | hours-api: `bun run typecheck && bun test` (`hours_test`) | 0 errors, 0 fail | typecheck OK; 2114 pass, 0 fail, 51 files | ✓ |
| 3 | meetings-api: `bun run typecheck && bun test` (`meetings_test`) | 0 errors, 0 fail | typecheck OK (including `evals/tsconfig.json`); 2145 pass, 0 fail, 92 files (3 of them my real-ffmpeg test) | ✓ |
| 4 | hours-ui: `pnpm lint && pnpm build && pnpm test` | 0 errors, 0 fail | lint 0; build OK (the existing >500 kB `hoursWorkbook` chunk warning only); 2794 tests pass, 94 files | ✓ |
| 5 | meetings-ui: `pnpm lint && pnpm test` | 0 errors, 0 fail | lint 0; 1094 tests pass, 57 files | ✓ |
| 6 | `mise run shared:check` | in sync | 35 groups in sync, `meetingHoursWire` and `systemAuth` included | ✓ |
| 7 | `mise run env:doctor` | pass | all 12 services pass | ✓ |
| 8 | `mise run changeset:check` | pass | OK, matched `.changeset/meeting-hours-automatic-entries.md` | ✓ |
| 9 | e2e `meeting-hours.spec.ts`, twice (flags below) | 3/3 twice | 3 passed (36.9 s), 3 passed (34.2 s), measured at `6e5f6714` | ✓ |
| 10 | shell `pnpm lint` (whole app, my added specs included) and `tsc -p tsconfig.e2e.json --noEmit` | 0 | 0 and 0 | ✓ |
| 11 | env-doctor and shared-copies unit tests, `bun test ./tools/env-doctor/ ./scripts/check-shared-copies.test.ts` | 0 fail | 343 pass, 0 fail, 8 files (run at `6e5f6714`; nothing under those paths changed since) | ✓ |
| | Line coverage | n/a | not measured: no coverage tool or threshold is configured for these packages (bunfig / vitest configs hold none) and T14 names none; I did not invent one | n/a |
| | Dependency audit | no new dependency | `git diff 831bf3fb..HEAD` touches no `package.json` or lockfile; T18 reached the same finding | ✓ |

e2e flags (from `meeting-hours.spec.ts`'s header and decisions.md T11): the eleven `E2E_*_REMOTE_PORT` of the dev ports
(`5174 5175 5176 5177 5178 5179 5180 5181 5182 5183 5184` in the order estimai, refund, notify, admin, inventory, crm, meetings,
projects, letterheads, accounting, hours) and `E2E_SKIP_ACCOUNTING_SEED=1 E2E_SKIP_REFUND_ACCOUNTING_RELEASE=1 E2E_SKIP_LEGAL_ENTITIES_SETUP=1`.

## AC sweep (28 of 28)

Levels as plan § Test strategy: U unit, I-H hours-api integration, I-M meetings-api integration, C hours-ui / meetings-ui component, E e2e.
"N pass" is that file run alone (hours-api on `hours_test`, meetings-api on `meetings_test`); all of them also ran inside the whole-suite
runs of the gate table. Paths are under the package named.

| AC | Tests (path, run) | Result |
|---|---|---|
| 1.1 | U `hours-api/src/meetingHours/desired.test.ts` (37 pass); I-H `apply.test.ts` (50) "creates one entry per person"; I-M `meetings-api/src/hours/triggers.test.ts` (27), `src/jobs/handlers/deliverHoursNotice.test.ts` (19); E `shell/e2e/meeting-hours.spec.ts` A (2 runs) | ✓ |
| 1.2 | U `desired.test.ts`; I-H `apply.test.ts` "one entry, not two" | ✓ |
| 1.3 | U `desired.test.ts` (null and 0); I-H `apply.test.ts`; I-M `triggers.test.ts` (text meeting, upload refused past 3 h gives `durationMs: null`) | ✓ |
| 1.4 | I-H `apply.test.ts` (block `had_entry`, stays after the hand-made entry is deleted) | ✓ |
| 1.5 | U `desired.test.ts`; I-H `apply.test.ts`; `hours-api/src/db.constraints.test.ts` (46) and `src/migration.seed.test.ts` (10) for the release row | ✓ |
| 1.6 | I-H `hours-api/src/matrix.test.ts` (271) pins the one `/system/` route; `notices.routes.test.ts` (36). Static: `apply.ts:151` is the only writer of `origin: "meeting"`, and only `meetings-api/src/hours/client.ts` calls the route | ✓ |
| 1.7 | I-H `notices.routes.test.ts` (user JWT of admin and of a read-all holder: the one 401), `src/entries/automatic.test.ts` (18; `owner_only` / 404), `src/auth/systemAuth.middleware.test.ts` (7) | ✓ |
| 1.8 | I-H `apply.test.ts` "passes every rule of an entry on a meeting", "counts for the meeting's deal"; `db.constraints.test.ts` | ✓ |
| 2.1 | C `hours-ui/src/components/TableView.fromMeeting.test.tsx` (12); E `meeting-hours.spec.ts` A, B (2 runs) | ✓ |
| 2.2 | I-H `apply.test.ts` ("listed with everyone's hours, and by the deal filter", deal totals), `automatic.test.ts` | ✓ |
| 2.3 (changed) | U `hours-ui/src/lib/fromMeetingMark.test.ts` (12); C `EntryRow.test.tsx` (21), `EntriesTable.test.tsx` (43), `TableView.fromMeeting.test.tsx` (12), moved-off-and-back and hidden-meeting cases; I-H `automatic.test.ts` (`origin` stays `meeting` after a PATCH or a move); **E, real browser, written by QE:** `shell/e2e/meeting-hours-moved.spec.ts` B-D, 4 runs of 5/5, screenshots in `qe-evidence/` | ✓ |
| 2.4 | I-H `automatic.test.ts` (saved change clears following; refused PATCH writes nothing, row byte-identical); `apply.test.ts` | ✓ |
| 2.5 | I-H `automatic.test.ts` (block `deleted`, touched or not, one transaction), `apply.test.ts` (never recreated; DELETE racing apply, repeated rounds); E `meeting-hours.spec.ts` C (2 runs) | ✓ |
| 2.6 | I-H `apply.test.ts` "asks no owner and sends nothing", `notices.routes.test.ts` "calls nobody". Static: hours-api has no notification client | ✓ |
| 2.7 | C `DeleteEntryDialog.test.tsx` (9), `DeleteEntryDialog.it.test.tsx` (3); E `meeting-hours.spec.ts` C (2 runs); E `meeting-hours-moved.spec.ts` E (moved entry, 4 runs, with focus and accessible description) | ✓ |
| 3.1 | I-H `apply.test.ts`; I-M `triggers.test.ts` (PATCH `startsAt`; a title-only PATCH records none) | ✓ |
| 3.2 | I-H `apply.test.ts`; I-M `triggers.test.ts` (`prepare_audio` fills a null duration) | ✓ |
| 3.3 | I-H `apply.test.ts` (no block on removal; creator outside `participantIds` keeps theirs); I-M `triggers.test.ts` (participants PUT) | ✓ |
| 3.4 | I-H `apply.test.ts` (`facts: null`); I-M `triggers.test.ts` (DELETE, also via `meeting:erase`), `deliverHoursNotice.test.ts` (delivered after the meeting is gone) | ✓ |
| 3.5 | I-H `apply.test.ts`, including the two-connection PATCH-vs-apply cases. Mutation M3 below fails exactly those | ✓ |
| 3.6 | I-H `apply.test.ts` (stays; view `hidden`, no label once the meeting is gone); C `EntryRow.test.tsx`, `EntriesTable.test.tsx` ("Not visible to you") | ✓ |
| 3.7 | I-H `apply.test.ts` (added after the duration is known, unless blocked) | ✓ |
| 3.8 | U `meetings-api/src/media/measuredDuration.test.ts` (21); I-M `src/jobs/handlers/prepareAudio.measured.test.ts` (14; `status` still `processing`); C-M `meetings-ui/src/pages/MeetingPage.test.tsx` (66); **real ffprobe/ffmpeg, written by QE:** `meetings-api/src/media/prepare.measured.real.test.ts` (3 pass); real stack: an isolated `c3c963b3` meetings-api 5/5 (first pass) and the restarted dev stack 5/5 (second pass, spec `meeting-hours-measured.spec.ts`) | ✓ |
| 3.9 | I-M `prepareAudio.measured.test.ts` (version 2 delivered with the measured duration); I-H `apply.test.ts` (untouched takes it, changed keeps its values); real stack: entry `60` then `30` min in 5 of 5 runs on the isolated instance (first pass) and in 5 of 5 on the restarted dev stack (second pass) | ✓ |
| 3.10 | U `measuredDuration.test.ts` (within-margin vectors, 44:00 / 46:00); I-M `prepareAudio.measured.test.ts` (within margin, unreadable, `too_long`, upload past 3 h), `prepareAudio.refuse.test.ts` (9); real `prepare.measured.real.test.ts` (12.5 s claimed over 12 s stays 12.5 s) | ✓ |
| 4.1 | I-H `apply.test.ts` (note null), `notices.routes.test.ts` (strict body, a `title` is 400), `src/lib/meetingHoursWire.test.ts` (38) | ✓ |
| 4.2 | I-M `deliverHoursNotice.test.ts` (503 then 200, backoff 30 s, 2 min, 10 min, 30 min, 400 settles as failed, channel off), `src/hours/delivery.backfill.test.ts` (6); I-H `apply.test.ts` (same notice twice, older version, all or nothing, row lock); existing `hours-api/src/entries/view.test.ts` ("meetings-api does not answer: still listed and counted"); C `EntryRow.test.tsx` ("Name unavailable, the mark does not need Meetings") | ✓ |
| 4.3 | C `hours-ui/src/strings.test.ts` (`catalogGaps`, 43), `src/lib/noHardcodedStrings.test.ts` (43), `EntryRow.it.test.tsx` / `EntriesTable.it.test.tsx` / `DeleteEntryDialog.it.test.tsx` (3 each: "Da riunione", the Italian paragraph) | ✓ |

## Tests that can fail: what I checked

A test that passes the first time proves nothing until it is seen failing. I never edited production code in place (the permission
classifier refused one such edit and I did not work around it); mutations ran in throwaway copies under `/tmp`, with the repo untouched.

| Mutation (copy of the package) | Tests that went red |
|---|---|
| meetings-api M1: `durationAfterMeasure` always returns the held duration | `prepare.measured.real.test.ts`: 2 of 3 (the two corrections) |
| meetings-api M2: `durationAfterMeasure` always returns the measured duration | `prepare.measured.real.test.ts` within-margin case; at least 9 cases of `measuredDuration.test.ts` and 3 of `prepareAudio.measured.test.ts` (my output listing was cut at 12 lines) |
| hours-api M3: `apply()`'s move/resize `UPDATE` loses its `followsMeeting: true` guard (the CAS against a concurrent PATCH) | the two AC-3.5 race tests of `apply.test.ts` |
| hours-api M4: DELETE no longer writes the `deleted` block | 8 tests (`automatic.test.ts` AC-2.5 block tests, `apply.test.ts` "never records again") |
| hours-api M5: a person's PATCH no longer clears `followsMeeting` | 10 tests (`automatic.test.ts`, `apply.test.ts` AC-2.4, 3.5, 3.9) |

Each copy's unmutated baseline was green first (3 of 3 and 68 of 68). For `meeting-hours-moved.spec.ts` I did not mutate the
predicate; its proof is that the same locator, `hours-entry-<id>-from-meeting`, is found with the text "From meeting" in steps B and D
and absent in C and E, on the same entry, so the "absent" observations are real. The mark predicate's own failure behaviour is covered by the
unit tests above, which the developers mutation-checked (decisions.md) and which I did not re-mutate.

## Exploratory pass (Playwright, real browser, the dev shell on :5173)

Identity: per-run `@operai.test` people of the T11 harness (a holder creator, plus the shared admin for Everyone's hours). Nothing stubbed:
the creator records 12 s with the in-browser recorder, meetings-api announces it, hours-api writes the automatic entry.
Screenshots, element captures: `specs/20261112-meeting-hours/qe-evidence/`.

**design S1 step for the changed AC-2.3 (the step T16 could not render): ✓**, `shell/e2e/meeting-hours-moved.spec.ts`, 5/5 in each of 4 runs.

| State | List | Table cell's entries | Everyone's hours (admin) | Evidence |
|---|---|---|---|---|
| On its meeting | `[Meeting] [From meeting] <title>` | marked | `[From meeting] Not visible to you` / `Meeting` | `B1`, `B2`, `B3` |
| Edited onto Other work (Training) | `[Other work] Training`, no mark | cell is the category's, no mark | `Other work · Training`, no mark | `C1`, `C2`, `C3` |
| Edited back onto the meeting | mark returns | mark returns | mark returns | `D1`, `D2` |
| Moved again, then deleted | no mark, but the confirmation reads "30 min on other work (Training), 24.11.2026. This can't be undone." then "Operai won't record it again from its meeting. You can still record hours yourself." | | | `E1` |

Also asserted in the same journey: `origin` is still `meeting` in hours-api after the move (D70); the delete dialog opens with focus on
Cancel, its accessible description contains both sentences, and Tab then Enter confirms by keyboard; the entry is gone after a reload
and from hours-api. The admin's Everyone's hours shows the meeting as "Not visible to you" (visibility by participation), as designed.

**AC-3.8 / design G7: driven, green on the restarted dev stack (first pass blocked by EF-1, now closed).** A fake microphone cannot produce a difference past the 30 s floor, so
`shell/e2e/meeting-hours-measured.spec.ts` drives the recording API: a real 12 s Opus file cut into 240 byte slices, each confirmed as 15 s,
so the meeting holds exactly one hour (the review's L1 case, with readable audio).

| Where it ran | Result |
|---|---|
| meetings-api started by me on `c3c963b3`, `meetings_test`, dev auth / hours-api / MinIO | **passed 5 of 5.** Meeting timeline `processing/preparing 3600000` then, in the same `processing` state, `12007`, then `ready 12007` (seen while still processing in 4 of 5 timelines; the fifth flipped inside one 40 ms poll). Recorder figure stays `3600000` (A43). Entry `60` then `30` min in all five timelines (asserted in the last four; the first run was before I added that assertion). The Details card's Duration line read `00:00:1x`, not `01:00:00` (browser step, shell calls rerouted to that instance) |
| dev stack meetings-api (:8085), first pass, before the restart (four job runners) | **failed 6 of 6**: timeline `processing/preparing 3600000` then `ready 3600000`, entry stays 60 |
| dev stack meetings-api (:8085), second pass, after the owner's restart (one job runner), `d04d80ad` | **passed 5 of 5.** `processing/preparing 3600000` then, while still `processing`, `12007` (5 of 5 timelines), then `ready 12007`; entry `60` then `30` in all five; Duration line asserted by the spec's browser step. Full table under *This pass* |
| `prepare.measured.real.test.ts` (real ffprobe/ffmpeg through `createPrepareAudio`) | 3 of 3: `heldMs: 3600000, measuredMs: 12007`, `status` still `processing`; claim 5 s over 45 s corrected up; 12.5 s over 12 s kept |

Design G7 as a pure browser observation ("the Duration line changes while the meeting is still processing") was not made: with the fake AI
provider the window is about 0.3 s and the page polls every 5 s. The API timeline above is the observation, `prepareAudio.measured.test.ts`
pins the ordering, and `MeetingPage.test.tsx` pins the polling behaviour.

## Defects

None. Nothing is filed against a dev agent.

## Environment faults (no owning dev agent, no fix round)

**EF-1 (CLOSED in the second pass): the dev meetings-api's job runners were not all running the code on disk.**
Resolution: the owner restarted `mise run dev`; `pg_stat_activity` then showed one `LISTEN meetings_jobs` connection (pid 43897, started 15:39:16 CET)
and `meeting-hours-measured.spec.ts` passed 5 of 5 against that dev meetings-api (it had failed 6 of 6). First-pass findings, kept for the record:
1. The failure is not the code. `prepare.measured.real.test.ts` runs the real `createPrepareAudio` with the real ffprobe and ffmpeg on
   `c3c963b3` and corrects `3600000` to `12007` with the meeting still `processing`. A meetings-api I started on `c3c963b3` against the
   same dev auth, hours-api and MinIO passed the e2e spec 5 of 5, the dev one 0 of 6. The only difference is which meetings-api process.
2. The dev process (pid 1146, `bun run --hot src/index.ts`) started at 13:31:09; the correction landed at 14:47:08. `pg_stat_activity`
   shows four `LISTEN meetings_jobs` connections on database `meetings`, i.e. four job runners, started at 13:31:09, 14:47:09, 14:51:18 and
   14:51:18: the last three at the minute `measuredDuration.ts` and `prepareAudio.ts` were written (mtime 14:47:08) and at the T17 edit of
   `serviceToken.ts` (14:51:18). `startWorker()` builds a runner once with the handler table of that moment, and `--hot` starts another
   instead of replacing it.
3. What I could not establish: which runner claimed my jobs and which version of `prepareAudio` it held. All six dev runs failed, so it is
   not simply a random pick among four. I could not read that process's loaded modules or its log. Treat "stale runner state from hot
   reloads" as the best-supported explanation, not a proven one. The restart settled the question of fault versus defect (green after a
   clean restart: the environment); it did not prove the mechanism.
4. Related and not mine to change: the orchestrator's note says "hot reload means it serves the current code". For the job runner that
   is not true, and any reviewer who runs `meeting-hours-measured.spec.ts` against a long-lived dev stack will see the same red.

Other environment facts: notify-api (:8081) and accounting-api (:8089) are not running, as decisions.md T11 says. Nothing in this feature
needs them (participant notifications are best effort; the e2e flags skip the accounting setup). Starting meetings-api through
`direnv exec` blocks on a 1Password prompt (`op read` of the GCP service-account key), so I started my instance with an explicit
environment and left the credentials to the service's own gitignored env file, which Bun loads itself; I did not read it. I verified the
instance's database from `pg_stat_activity` (one runner on `meetings_test`, the dev `meetings` database unchanged). It is stopped.
Residue from my runs: `@operai.test` people, meetings and entries were removed by the specs' cleanup; hours-api keeps a few
`meeting_hours_meeting` version rows for meeting ids that exist only in `meetings_test`, which are harmless.

## Not run, outside what QE can execute

- **R9's pre-merge check** (infra/README § The measured duration): record with the real recorder for 2 min, 15 min and an interrupted and
  resumed session, upload a 10-minute m4a and webm, and expect no `duration_corrected` line. It needs a real microphone and a person
  (decisions.md T17 says so). It is the one thing that tells whether max(30 s, 10 %) corrects honest recordings.
- A real browser in Italian (AC-4.3 is proven by the three `.it` component tests and `catalogGaps`), the 320-375 px layout and the badge
  contrast figures (4.99:1 light, 6.29:1 dark) are the designer's measurements; I did not re-measure them.

## Observations (not defects; owners named)

- **PATCH clears following on any successful PATCH, including one that sends the stored values.** Spec A39 says "any saved *change*";
  plan and decisions T5 say "every successful PATCH". The entry dialog sends only changed members (and nothing at all when nothing changed),
  so the UI cannot reach it; a direct API caller can. The ADR rejects value comparison on purpose. Owner: spec author, if A39's wording should
  say "saved PATCH".
- **Dev-only hazard behind EF-1, not a defect of this feature.** Under `bun --hot` each reload of meetings-api started another job
  runner (`startWorker()` builds one with the handler table of that moment, observed as four `LISTEN meetings_jobs` connections in the
  first pass). Production does not run `--hot`, so no AC is affected. If the owner wants dev to match what the code says, the owner of
  `meetings-api/src/jobs` (backend-dev) could make the runner dispose on hot reload; I did not test such a change and do not recommend it
  as part of this feature. Until then: restart the dev stack before reading a red `meeting-hours-measured.spec.ts` as a defect.
- The backfill sends no A37 second delivery (known, ledger D71). Not re-tested.
- Design status line says `draft`; the plan and spec are approved. Housekeeping for `/wellforge:done`, not a QE finding.

## Tests I added (committed in `c3c963b3`)

- `shell/e2e/meeting-hours-moved.spec.ts`: the mark follows the entry's target, in a real browser, with keyboard and a11y assertions.
- `shell/e2e/meeting-hours-measured.spec.ts`: AC-3.8 / AC-3.9 end to end (header says when it means something, and how to point it at an
  isolated meetings-api with `E2E_MEETINGS_API_URL`).
- `meetings-api/src/media/prepare.measured.real.test.ts`: the correction through the real ffprobe and ffmpeg.

## Security

T13 (`owasp-report.md`, PASS) and T18 (delta, PASS, commit `6e5f6714`) are in the repository. I found nothing that changes either verdict
and my tests add no new surface (no new dependency, route, credential or outbound call). No further owasp-reviewer pass recommended.

## Self-critique

The verdict moved from BLOCKED to PASS on one change of evidence: the same spec, on the same code, went from 0 of 6 to 5 of 5 once the
owner restarted the stack, with the runner count going from four to one. That shows the environment was the cause; it does not show *how*,
and I did not reproduce the stale-runner accumulation (that would mean hot-reloading the owner's meetings-api), so EF-1's mechanism is
still inferred and the first thing I would distrust. Second, the stack was about a minute old when I ran, so a green here says nothing
about the next long-lived `--hot` session; a developer who sees the spec red against an old dev stack should restart before filing a
defect, as the spec's header says. Third, my proof that the moved-entry journey can fail is still the same locator seen present and
absent, not a mutation of the predicate, which I was not allowed to edit in place, and the isolated-instance A/B of the first pass leans
on a service env file I did not read for its credentials. Fourth, I re-ran no gate: I relied on `git diff --name-only c3c963b3..HEAD`
showing only `specs/` files, which is a statement about paths, not about behaviour. Last, the Duration line during `processing`
(design G7) is still observed through the API timeline and not in the browser, for the reason given above (a 5 s poll over a window of
about 0.3 s with the fake AI provider).
