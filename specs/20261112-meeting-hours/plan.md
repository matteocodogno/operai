---
spec: 20261112
status: approved
approved: 2026-11-24
---

# Plan: Meeting hours — the hours of a meeting recorded automatically for the people who took part

Spec: `specs/20261112-meeting-hours/spec.md` (approved 2026-11-24 at 25 acceptance criteria, approved again the same day at 34
after the security review; ledger D54–D73). Builds on specs/20261112-time-tracking (hours-api, hours-ui) and
specs/20261104-meetings (meetings-api); no screen of its own. Design: `design.md` (the mark's placement, tone and copy win over
this plan's § hours-ui sketch; its second pass, after the security review, is folded in below).

> Amended 2026-11-24 after /wellforge:design, before approval: the mark is `Badge tone="accent"` and reads
> "Da riunione" in Italian (D60); the delete confirmation of an automatic entry gains a sentence (spec AC-2.7, D61);
> AC-2.3 names Everyone's hours (D62). Test rows AC-2.3 and AC-2.7 updated.

> Amended 2026-11-24 after implementation: corrections the implementing agents and the security review surfaced
> (`decisions.md` T6 to T9 and T12, `owasp-report.md` L1). No scope and no acceptance criterion of `spec.md` changes.
> 1. § Deploy order: `HOURS_API_URL` on meetings-api is a precondition of meetings-api's deploy (new step 0), because its
>    production `env.ts` exits at start without it.
> 2. § API contracts, the notices route: a body over the global 64 KiB cap is a 413, decided before the guard, and a body
>    not declared as JSON a 415, after it, as on every hours-api route; 400 `invalid_request` stays for a JSON body the
>    wire refuses; the order of the answers.
> 3. § Release backfill: the backfill queues no A37 second delivery, so a meeting whose Zurich day is still ahead at the
>    release gets its entries only at its next change of a hours fact. A known, accepted limit.
> 4. § Where meetings-api records a notice: `recordHoursNotice(tx, meetingId, { before } | { deleted: true }, now)`, with
>    `before` a `readHoursFacts` snapshot taken under the meeting's row lock before the write and compared after it.
>    § Applying a notice step 4 and the DELETE bullet: `apply()` reads entries and blocks in ONE statement (`readState`),
>    which is what makes a concurrent DELETE safe.
> 5. § Security, "Abuse by a meeting's creator": the duration is bounded by 3 h 1 min, so an entry is at most 180 minutes
>    (not "capped at 24 h"), it is never checked against the audio, and `startsAt` is a third creator-controlled input.

> **Amended 2026-11-24 for the security-review additions (awaiting approval).** The owner added five hardenings to the spec
> (ledger D63–D73, spec AC-2.3 changed, AC-3.8–AC-3.10, AC-4.4–AC-4.5 and AC-5.1–AC-5.4 added; `owasp-report.md` L1, I1, I3, I6,
> I8) and the designer's second pass (design.md, G7) depends on one of them. What this amendment adds or changes:
> 1. **The measured duration** (AC-3.8–AC-3.10, D63, D68, D69): new § The measured duration; `prepare_audio`'s one commit takes
>    the measured duration when it differs from the held one by more than the larger of 30 s and 10 % (a pure rule), while the
>    meeting is still `processing` (design G7); the existing before/after compare announces it, so untouched entries follow
>    with no change in hours-api. New D-P6, D-P10.
> 2. **Refused service credentials recorded** (AC-5.1, AC-5.2, D64, D72): new § Refused service credentials; one log line in the
>    shared region of the service-credential guard, changed in all six copies in one commit; the 401 unchanged. New D-P8.
> 3. **Identifiers on the wire** (AC-5.3, AC-5.4, D65, A45 **resolved**, evidence in § Identifiers on the wire): ids
>    `[A-Za-z0-9_.:-]{1,64}` in both copies of the wire; both sides already refuse such a notice for good. New D-P9.
> 4. **A deleted meeting keeps no blocks** (AC-4.4, AC-4.5, D66): § Applying a notice gains `gone`; the person's DELETE takes
>    the meeting's version row `FOR SHARE` and writes no block once `gone`; one additive hours-api migration. New D-P7.
> 5. **The mark follows what the entry is on now** (AC-2.3 changed, D67, D70, A47; design S1): one predicate
>    `origin === 'meeting' && on.type === 'meeting'` in hours-ui; the delete sentence keeps `origin` alone. D-P5 rewritten;
>    § Security's G6 note superseded.
>
> Also changed: § Components, § Where meetings-api records a notice (the `prepare_audio` row), § Deploy order (a pre-merge
> identifier check and four more services), § Data model, § API contracts, § Test strategy (rows AC-2.3, AC-2.7 and AC-3.2
> changed, nine rows added), § Risks R9–R17, § Security, § ADR candidates 3–6.

## Architecture

### Shape in one paragraph

meetings-api owns the facts (when a meeting started, how long it lasted, who created it, who took
part); hours-api owns the entries. Whenever one of those facts changes, meetings-api records, **in
the same transaction**, a content-free row in a new until-delivered outbox (`hours_notice`) and bumps
a per-meeting version (`Meeting.hoursSeq`). Its existing job runner delivers the row: it reads the
meeting's **current** facts at send time and POSTs them, with the current version, to a new hours-api
route `POST /system/meeting-hours/v1/notices` as `system:meetings-api` (new scope
`meeting-hours-notices.send`). hours-api applies a notice in one transaction under a row lock on the
meeting's applied version: it ignores a notice older than the one it applied, then makes the meeting's
**untouched** automatic entries match the facts (create, move, resize, remove), never touching an
entry its person changed, and never creating one its person deleted or one for a person who already
had an entry on the meeting. Automatic entries are ordinary `time_entry` rows with three new columns
(`origin`, `sourceMeetingId`, `followsMeeting`), so every list, total, filter, export and deal figure
counts them with no change (AC-2.2). hours-ui shows a "From meeting" badge from the new `origin` field
while the entry is on a meeting. Processing a meeting's audio may correct its duration once (the
measured duration), which reaches hours-api as any other change of a fact; and once a meeting's
deletion is applied hours-api keeps only its version row.

### Components

| Component | Change |
|---|---|
| **meetings-api** | `Meeting.hoursSeq`; table `hours_notice`; `JobKind` gains `deliver_hours_notice`; `src/hours/notices.ts` (`recordHoursNotice`, called from seven write paths, below); `src/hours/client.ts` (`sendHoursNotice`); `src/jobs/handlers/deliverHoursNotice.ts`; env `HOURS_API_URL`; a migration that also enqueues the release backfill. **Amendment:** `src/media/measuredDuration.ts` (pure `durationAfterMeasure`, AC-3.8, AC-3.10); `src/jobs/handlers/prepareAudio.ts` step-3 commit (`:254-270`) takes the measured duration through it and logs a correction; `src/hours/delivery.ts` `refuse()` (`:108-111`) never prints a malformed meeting id (AC-5.3) |
| **hours-api** | three `time_entry` columns + CHECKs + a partial unique index; tables `meeting_hours_meeting`, `meeting_hours_block`, `meeting_hours_release`; `src/auth/systemAuth.middleware.ts` (a byte-identical copy of meetings-api's, added to the `systemAuth` group of `scripts/check-shared-copies.ts`); `src/meetingHours/` (`desired.ts` pure, `apply.ts`, `notices.routes.ts`); the PATCH and DELETE handlers of `src/entries/entries.routes.ts` (`:351-363`, `:377`); `TimeEntryView.origin` in `src/entries/view.ts`. **Amendment:** migration `<ts>_meeting_hours_gone` (`meeting_hours_meeting.gone`); `apply()` (`src/meetingHours/apply.ts:111-114`, `:160-161`) drops a deleted meeting's blocks and takes no notice after it; the DELETE handler (`entries.routes.ts:384-412`) takes the entry's meeting version row `FOR SHARE` and writes no block once it is `gone` (AC-4.4); the PATCH handler's comment "`origin` is never written: the mark stays (AC-2.3)" (`:368`) becomes "`origin` is never written (AC-2.7 and A47 read it)" |
| **hours-ui** | `origin` on `TimeEntryView` (`src/lib/hoursApi.types.ts:42-57`); a "From meeting" `Badge` in `src/components/EntryRow.tsx` (List and table cell dialog) and in `src/components/EntriesTable.tsx` (Everyone's hours); a second paragraph in `src/components/DeleteEntryDialog.tsx` for an automatic entry (AC-2.7); strings in `src/strings/entries.ts` and `src/strings/entry.ts` (en + it) — placement and copy per `design.md`. **Amendment:** the badge's condition moves into one predicate, `showsFromMeetingMark` in `src/lib/fromMeetingMark.ts`, called by `EntryRow.tsx:97` and `EntriesTable.tsx:68` (design S1, component inventory); `DeleteEntryDialog.tsx:89` keeps `origin === 'meeting'` alone (D70); the `origin` doc comment of `hoursApi.types.ts` and the two components' doc comments rewritten (design § What this changes in the built code). No new string |
| **both services** | `src/lib/meetingHoursWire.ts`: the notice body's zod schema and caps, a byte-identical copy in meetings-api and hours-api (new `meetingHoursWire` group in `scripts/check-shared-copies.ts`). **Amendment:** ids match `^[A-Za-z0-9_.:-]{1,64}$`; exports `isMeetingHoursId` (AC-5.3, AC-5.4) |
| **the shared service-credential guard** (amendment) | `*/src/auth/systemAuth.middleware.ts`, region `systemAuth`, in **crm-api, estimai-api, activities-api, accounting-api, meetings-api and hours-api**, one commit (D72): a correctly signed credential refused for its `sub` or its scope logs one `[system-auth] refused` line (AC-5.1); the 401 is unchanged byte for byte (AC-5.2). Three guards are NOT in the group and do not change (D72 names six copies): notify-api's (`src/system/systemAuth.middleware.ts`), projects-api's (`src/system/systemAuth.middleware.ts`, `GET /system/purchase-orders`) and estimai-api's second one (`src/system/systemAuth.middleware.ts`, `GET /system/estimates/{id}/summary`); nor do auth's `/system` routes |
| **meetings-ui** (amendment) | nothing to build: the Duration line (`DetailsCard.tsx:65-69`) renders the `durationMs` the meeting view returns (`meetings-api/src/meetings/view.ts:221`), so it shows the measured duration once written (A43, design S5) |
| **auth** | scope `meeting-hours-notices.send` in `KNOWN_SERVICE_SCOPES` (`auth/src/system/serviceClients.ts:78`), documented; the prescribed scopes of client `meetings-api` gain it |
| **tools/env-doctor** | meetings-api `HOURS_API_URL` (required in production); the meetings-api `SERVICE_CLIENTS` scope set; hours-api `SERVICE_AUDIENCE` now verifies something (already required) |
| **AGENTS.md, infra/README.md, changesets** | Time tracking glossary (automatic entry), hours-api and meetings-api descriptions, the service-client scope list. **Amendment:** the automatic-entry rows say the mark shows "while it is recorded on a meeting" (not "kept after a change"); meetings-api's write list says "filling, correcting or refusing a duration"; hours-api's paragraph says blocks are dropped when a meeting's deletion is applied; infra/README § Meeting hours release gains the pre-merge identifier check and the two new operator log lines; a new changeset (below, § Deploy order) and the feature changeset's text for the mark and the measured duration |

Nothing changes in projects-api, notify-api or the shell. crm-api, estimai-api, activities-api and accounting-api change only
their copy of the shared guard (a log line, D72).

### Where meetings-api records a notice

`recordHoursNotice(tx, meetingId, change, now)` (`src/hours/record.ts`), with `change = { before: HoursFacts | null }
| { deleted: true }`, runs inside the write's own transaction. A write that may change a fact first takes a snapshot,
`before = await readHoursFacts(tx, meetingId)`: the meeting's `startsAt`, `durationMs` and Operai participant ids
(distinct, sorted), read under the meeting's row lock (`SELECT … FOR UPDATE`), so that no concurrent change can land
between the snapshot and the write unannounced. Every path takes that lock for its own write anyway, in the same order
relative to its other rows, so no new deadlock. The path then makes its write and calls
`recordHoursNotice(tx, id, { before }, now)`, which reads the facts again and compares. It records a notice only when a
**hours fact** changed — `startsAt`, `durationMs`, the set of Operai participant ids (the creator never changes, so it
is not compared; the body carries it, read at send time) — **and** the meeting has a non-null `durationMs` before or
after the write (0 counts as known here; hours-api reads 0 as not known, D-P4). A deletion passes `{ deleted: true }`,
before `meeting.delete`, and records one only when `hoursSeq > 0` (something was sent before). The rule lives in that
one function: the seven paths below only snapshot and call it. It is a no-op when the hours channel is disabled (below).

| Write | File (today) | What changed |
|---|---|---|
| Recording stop → processing (`beginProcessing`) | `src/capture/recording.routes.ts:378-395` | `durationMs` set |
| Upload confirm | `src/capture/upload.routes.ts:182-192` | `durationMs` set (may stay null: probe gave none) |
| `prepare_audio` fills a null duration, **or replaces a held one the measured duration differs from materially** (amendment, AC-3.8) | `src/jobs/handlers/prepareAudio.ts:254-270` (only when it wrote it) | `durationMs` set or changed |
| `prepare_audio` refuses an upload over 3 h | `src/jobs/handlers/prepareAudio.ts:181-185` | `durationMs` → null |
| `PATCH /meetings/{id}` with a different `startsAt` | `src/meetings/core.routes.ts:195-198` | `startsAt` |
| `PUT /meetings/{id}/participants` changing the userId set | `src/meetings/participants.routes.ts:90-122` | participants |
| `DELETE /meetings/{id}` (creator and `meeting:erase`) | `src/meetings/delete.routes.ts:104-119`, before `meeting.delete` | deleted |

Not recorded: a text meeting (`durationMs` always null), recording discard (only from `recording`,
before a duration exists), retry and transcription outcomes (they do not touch the facts), a PATCH of
title, format, language, source or host. A meeting relinked to another deal sends nothing: the deal it
counts for is read live by hours-api's views, as today (specs/20261112-time-tracking AC-2.6, A39).

What it writes: `UPDATE meeting SET "hoursSeq" = "hoursSeq" + 1 RETURNING "hoursSeq"` (the row lock, already held
from the snapshot for a state change; for a deletion only `WHERE "hoursSeq" > 0`),
one `hours_notice` row `{ meetingId, seq, kind: state|deleted }`, and one `deliver_hours_notice` job
`{ noticeId, maxAttempts: 1_000_000, runAfter: now }` via `enqueueJob` (`src/jobs/runner.ts:152-167`).
**A future day (A37):** when `kind = state` and the Zurich day of the new `startsAt` is after today in
Zurich, it writes a second row and job with `runAfter` = 00:01 Europe/Zurich of that day — the
delivery that day re-sends the then-current facts, which hours-api re-applies (equal versions are
re-applied, below). Zone arithmetic uses the same `Intl` approach as hours-api `src/entries/today.ts`.

### The measured duration (amendment: AC-3.8–AC-3.10, D63, D68, D69, A42, A43; design G7, S5)

**Where.** In `prepare_audio`'s step-3 commit (`src/jobs/handlers/prepareAudio.ts:254-270`) and nowhere else: the one
job-guarded transaction that already sets `audioKey`, `audioBytes` and `audioCreatedAt`, fills a null duration, records the
hours notice and enqueues `transcribe`. The measured duration is the value that commit already has in hand: `normalizeAudio`'s
ffprobe of the normalized `audio.ogg` (`src/media/normalize.ts:165-203`, "Returns the real duration of `output`"). No new read of
bytes and no new tool run, so ADR 20261104-meetings-api-reads-audio-bytes-third-reader is untouched.

**The rule** — pure, no I/O, integers only (`src/media/measuredDuration.ts`):

```ts
/** The smallest difference that is material, whatever the held duration: 30 s (A42). */
export const MEASURE_MARGIN_FLOOR_MS = 30_000;
/** A difference must also exceed held / 10, i.e. 10 % (A42), compared as d × 10 > held: no float. */
export const MEASURE_MARGIN_DIVISOR = 10;

/**
 * The duration a recorded or uploaded meeting holds once its audio has been measured.
 *   held null                                   → measured (no duration yet: today's rule, AC-1.1)
 *   |measured − held| > max(30 s, held × 10 %)  → measured (AC-3.8), shorter or longer, held 0 included
 *   otherwise                                   → held, even when the two round to different 30-minute steps (AC-3.10)
 * "More than the larger of a and b" is "more than a AND more than b".
 */
export function durationAfterMeasure(heldMs: number | null, measuredMs: number): number {
  if (heldMs === null) return measuredMs;
  const d = Math.abs(measuredMs - heldMs);
  return d > MEASURE_MARGIN_FLOOR_MS && d * MEASURE_MARGIN_DIVISOR > heldMs ? measuredMs : heldMs;
}
```

**The commit** (replaces `prepareAudio.ts:254-270`; the `durationMs` of the select at `:203`, read before ffmpeg ran, is no
longer used and leaves the select):

```ts
const committed = await ctx.commit(async (tx) => {
  const hoursBefore = await readHoursFacts(tx, meetingId);                 // the meeting's row lock; its duration is the HELD one
  const held = hoursBefore?.durationMs ?? null;
  const next = durationAfterMeasure(held, durationMs);                     // durationMs = the measured one (normalizeAudio)
  const updated = await tx.meeting.updateMany({
    where: { id: meetingId, status: "processing", audioKey: null },        // status is NOT changed here (G7, below)
    data: { audioKey: objectKeys.audio(meetingId), audioBytes: sizeBytes, audioCreatedAt: stamp,
            ...(next !== held ? { durationMs: next } : {}) },
  });
  if (updated.count === 0) return false;
  // Unchanged: compares before and after; a duration filled or corrected is a hours fact that changed, so a notice is recorded.
  await recordHoursNotice(tx, meetingId, { before: hoursBefore }, stamp);
  await enqueueJob(tx, { kind: "transcribe", meetingId });
  return { corrected: held !== null && next !== held, held, next };
});
// After the commit, only when a held duration was replaced (D-P10):
//   console.log("[prepare_audio] duration_corrected", { meetingId, heldMs, measuredMs })
```

The held duration is read **under the row lock in the commit**, not from the copy read before ffmpeg ran: nothing writes
`durationMs` while a meeting is `processing` today, but the decision must not depend on that staying true. The correction is
written whether or not the hours channel is on (it is a Meetings fact); only the notice depends on the channel.

**Why untouched entries follow with no hours-api change (AC-3.9).** `recordHoursNotice` already compares the snapshot with
the facts after the write (`src/hours/record.ts:110-119`); a corrected `durationMs` differs, both are non-null, so it bumps
`hoursSeq` and records a notice and a job. The delivery builds the body at send time (the measured duration), and `apply()`
resizes untouched entries (step 5, `AND "followsMeeting"`) and leaves changed ones (AC-3.5). A correction that rounds to the
same 30-minute step reaches hours-api and changes nothing (`moved: 0`).

**Before the meeting leaves `processing` (design G7).** This commit leaves `status = processing`; `transcribe` sets `ready`
later, in its own commit (`src/jobs/handlers/transcribe.ts:102-106`). meetings-ui polls a meeting while it is `processing`
(`meetings-ui/src/pages/MeetingPage.tsx:50-54`), so an open page reads the corrected duration on its next poll. **The correction
must never move to `transcribe` or later**: the page stops polling at the first read that is not `processing`, and would show
the held figure until the next visit (R15).

**What Meetings shows (A43, design S5).** The meeting view returns `durationMs: meeting.durationMs ?? recording.durationMs`
(`src/meetings/view.ts:221`), and the only place a meeting's duration is drawn is the Details' Duration line
(`meetings-ui/src/components/meeting/DetailsCard.tsx:65-69`); it shows the measured duration with no mention of the earlier one.
The recorder's running time and the interrupted recording's saved time read `recording.durationMs` (the sum of stored chunks,
`view.ts:173`) and do not change. Nothing is built in meetings-ui.

**AC-3.10's cases.**

| Case | What happens | Duration | Notice |
|---|---|---|---|
| Measured within the margin (any direction, even across a 30-minute step) | `next === held`, no `durationMs` in the update | held | none |
| Audio unreadable, or a source missing (`markFailed(…, "audio_unreadable")`, `:217-219`, `:284-297`) | the meeting is `failed`; the step-3 commit never runs | held (D69) | none |
| A **recording** that decodes past 3 h 1 min (`too_long`, `markFailed`) | as unreadable | held (D69) | none |
| An **upload** that decodes past 3 h (`refuseUpload`, `:176-197`, unchanged) | back to `draft`, `failureCode = too_long` | `null` | one, `durationMs: null` (AC-1.3) |
| No held duration (an upload whose probe gave none) | filled, as today | measured | one |
| Hours channel off | corrected | measured | none (`recordHoursNotice` is a no-op) |

**Not covered (R16):** a meeting processed before this release is never measured again, so the release backfill sends its held
duration. No reprocessing and no measurement script: the window is 14 days, the duration was creator-trusted before, and each
person can change or delete the entry.

**The e2e T11 stays valid (design G7 (b)).** `shell/e2e/meeting-hours.spec.ts` records for about 12 s (`:238`), plus at most
the 20 s it waits for "All audio saved", so the held duration is under ~35 s and the margin is its 30 s floor. A correction
would need the measured length to exceed the held one by more than 30 s (more audio than was recorded) or to be more than 30 s
shorter (below zero for anything under 30 s held; at most a few seconds of audio for 35 s held). Even then, every duration from
1 ms to 44 min 59 s rounds to 30 minutes (A36): the only value that would change the asserted entry is a measured 0 ms
(D-P4), which a 12-second tone does not decode to. The journey asserts the held duration right after Stop (`:247-251`), which
is still what it reads then.

### Delivering a notice (meetings-api)

`deliverHoursNotice` (job handler, mirroring `deliverHostNotice`, `src/jobs/handlers/deliverHostNotice.ts:16-27`):

1. Load the `hours_notice` row by `noticeId`; gone → done.
2. Build the body **at send time**: `kind = deleted` or the meeting no longer exists → `facts: null`,
   `seq = row.seq`; otherwise read the meeting and its participants with a `userId` (no external, no
   title, no content) → `facts`, `seq = meeting.hoursSeq` (≥ `row.seq`).
3. `sendHoursNotice` → `POST {HOURS_API_URL}/system/meeting-hours/v1/notices`, Bearer from the
   existing `serviceTokens` (`src/lib/serviceToken.ts:122-129`), 5 s timeout, `redirect: "error"`,
   one retry after a 401 with the token invalidated (as `src/hosts/client.ts:153-227`).
4. Outcome: **200** → delete the row (settled). **400 / 422** → permanent: row `state = failed`,
   `lastErrorCode`, logged `meeting_hours.notice_refused` with the code and meeting id only. Anything
   else (network, timeout, 401 after the retry, 403, 404, 409, 429, 5xx, token failure) → transient:
   `attempts++`, `TransientJobError(code, hoursNoticeRetryDelayMs(attempt))` — 30 s, 2 min, 10 min,
   then every 30 min (shorter than host notices' 6 h: an entry a person is waiting for, AC-4.2).

Several pending rows for one meeting are delivered independently and in any order; each sends the
facts as they are when it is sent, and hours-api keeps only the newest version, so order, repetition
and loss of all but the last are harmless.

**Hours channel enabled** iff `HOURS_API_URL` resolves and `serviceTokens` is non-null. `HOURS_API_URL`:
required in production (env.ts production list, as `CRM_API_URL`), defaults to `http://localhost:8090`
outside production. Disabled → `recordHoursNotice` writes nothing; a job that finds the channel
disabled marks its row `failed` `disabled` (permanent).

### Identifiers on the wire (amendment: AC-5.3, AC-5.4, D65; A45 resolved)

**A45 resolved: the set is `[A-Za-z0-9_.:-]`, 1 to 64 characters, and no identifier Operai creates falls outside it.**
Checked against every generator of an id that reaches the wire (2026-11-24):

| Identifier on the wire | Who makes it | Format | Inside the set |
|---|---|---|---|
| `creatorId`, `participantIds[]` (an auth user id) | better-auth on every sign-up: `@better-auth/core` 1.7.18 `generateId` = `createRandomStringGenerator("a-z","A-Z","0-9")(32)` (`auth/node_modules/@better-auth/core/dist/utils/id.mjs`; `auth/src/auth/auth.config.ts:367-372` sets no `advanced.database.generateId`) | 32 of `[A-Za-z0-9]` | yes |
| the same, for a row auth writes itself | Prisma `@default(cuid())` (`auth/prisma/schema.prisma:13`), used only by the dev/test session mint (`auth/src/test-auth/test-auth.routes.ts:163`); no migration or script inserts a user with a chosen id | `c` + 24 of `[a-z0-9]` | yes |
| the creator, at meeting creation | the verified JWT `sub` (`meetings-api/src/meetings/core.routes.ts:131`) — an auth user id | as above | yes |
| a participant | client text, 1..64 (`participants.routes.ts:32`), kept only if auth names it an active user (`:81-87`) — an auth user id | as above | yes |
| `meeting.id` | Prisma `@default(cuid())` (`meetings-api/prisma/schema.prisma:132`); no route takes a caller-chosen meeting id (`core.routes.ts:125-133`) | cuid | yes |
| `noticeId`, written live | Prisma `@default(cuid())` (`meetings-api/prisma/schema.prisma:476`, `src/hours/record.ts:92`) | cuid | yes |
| `noticeId`, release backfill | `gen_random_uuid()::text` (`migrations/20261124100000_hours_notice/migration.sql:59-60`) | 36 of `[0-9a-f-]` | yes |

Read-only count on the local development databases: auth `user` 501 rows (7 of 32-character better-auth ids, 494 cuids),
meetings 51 meetings and 29 Operai participants, hours 1 272 entries — **0** outside the set. Every id literal in the two
services' wire, apply, delivery and test-support code is inside it too (the only refused literal is the deliberate empty
`creatorId` of two refusal tests). The production check is a pre-merge step (§ Deploy order 0a, R10), because a refused notice
is final and refuses the **whole meeting**, not only the person whose id is malformed.

**The wire** (both copies of `src/lib/meetingHoursWire.ts`, one commit, `mise run shared:check`):

```ts
/** The characters of an Operai identifier on this wire (spec A45): letters, digits, `-`, `_`, `.`, `:`. A control character,
 *  a space or a NUL is never part of one (a NUL made a Postgres 500 the sender retried every 30 minutes, review I3). */
const ID_CHARS = /^[A-Za-z0-9_.:-]+$/;
const id = z.string().min(1).max(MEETING_HOURS_ID_MAX).regex(ID_CHARS);   // MEETING_HOURS_ID_MAX stays 64
/** Whether a value is an identifier this wire carries: for a log line that must never print one that is not. */
export const isMeetingHoursId = (value: string): boolean => id.safeParse(value).success;
```

`id` is used, as today, for `noticeId`, `meeting.id`, `creatorId` and every `participantIds` element. zod's regex message names
the rule, never the value; hours-api's 400 names the member (`field`), never the value (`src/lib/errors.ts:25-40`).

**Final on both sides, with no retry loop** — nothing new to build beyond the pattern:
- **Sender:** `attemptHoursDelivery` parses the body it built with the wire before sending (`src/hours/delivery.ts:126-128`); a
  refusal marks the row `failed` `invalid_notice` and ends the job normally (no `TransientJobError`), and any later job of that
  row finds it `failed` and stops (`:121`). Nothing is sent. The meeting's next change of a fact records a new notice, which is
  refused the same way while the malformed id is still in its facts.
- **Receiver:** the route parses with the same wire before `apply()`: a 400 `invalid_request`, nothing written. The sender maps
  400 to permanent (`src/hours/client.ts:148`), so the row is `failed` `invalid_request` and never sent again.
- **One log fix:** `refuse()` prints the row's meeting id into a template string (`delivery.ts:110`); a malformed meeting id is
  exactly the case where that id must not reach a log raw. It prints `meeting=${isMeetingHoursId(row.meetingId) ? row.meetingId
  : "invalid"}`. The `delivered` and `retry` lines only run for a body the wire accepted.

**Version skew:** an older hours-api accepts every body a newer meetings-api sends (a subset); a newer hours-api answers an
older meetings-api's malformed id with a permanent 400 instead of a retried 500. No deploy order follows from the wire change.

### Applying a notice (hours-api)

`POST /system/meeting-hours/v1/notices` is mounted **before** the user `jwtMiddleware` on `*`
(`src/index.ts:66`; the estimai-api lesson, ADR 20261104-estimai-api-first-system-route-estimate-man-days-for-a-service-credential: mounted after, a service JWT meets the user gate
and gets 401). `apply(notice)` runs in one transaction, with no outbound call:

1. `INSERT INTO meeting_hours_meeting ("meetingId", seq) VALUES ($1, 0) ON CONFLICT DO NOTHING`, then
   `SELECT seq, gone … FOR UPDATE` — serializes every apply of one meeting.
2. **(amendment) `stored.gone` → commit, `200 { applied: false }`: a meeting whose deletion was applied takes no further
   notice, whatever its version (AC-4.5, D-P7).** Then `notice.seq < stored.seq` → commit, `200 { applied: false }`. Equal is
   re-applied (the A37 day delivery, a repeated delivery): applying is idempotent.
3. `desired = desiredEntries(facts, since, today())` — pure (`src/meetingHours/desired.ts`):
   - `facts = null`, `durationMs` null or ≤ 0 → nobody.
   - `day` = the calendar day of `startsAt` in Europe/Zurich (A35); `day < since` (AC-1.5) or
     `day > today` (A37) → nobody.
   - `minutes = clamp(floor((durationMs + 900 000) / 1 800 000) × 30, 30, 1440)` (A36).
   - people = the distinct ids of `creatorId` ∪ `participantIds` (AC-1.2).
4. Read, in **one statement** (`readState` in `src/meetingHours/apply.ts`: a `UNION ALL` of `time_entry WHERE
   "meetingId" = M OR "sourceMeetingId" = M` and `meeting_hours_block WHERE "meetingId" = M`), the meeting's automatic
   entries (`sourceMeetingId = M`, touched or not, wherever their person moved them), the people who hold another
   entry on `M` (their own, or an automatic entry of another meeting they moved onto `M`), and its blocks. One
   statement is one snapshot (at Read Committed each statement takes its own), and that is what makes a concurrent
   DELETE safe: the person's DELETE removes the entry and writes its block in one transaction, so this read sees the
   entry or the block, never neither. Two reads could see neither, and step 6 would record again what the person just
   deleted (AC-2.5).
5. Each **untouched** entry (`followsMeeting`): its person not in `desired` → `DELETE … WHERE id = $1
   AND "followsMeeting"` (no block: a re-added person gets one again, AC-3.7); day or minutes differ →
   `UPDATE … SET day, minutes WHERE id = $1 AND "followsMeeting"`. The `AND "followsMeeting"` is the
   CAS against a concurrent PATCH by the person (AC-3.5).
6. Each person in `desired` with no automatic entry for `M` and no block: holds another entry on `M`
   → insert block `had_entry` (AC-1.4, stable from then on); else insert the entry `{ userId, day,
   minutes, target: meeting, meetingId: M, origin: meeting, sourceMeetingId: M, followsMeeting: true,
   note: null }`.
6b. **(amendment) `facts = null` (the meeting no longer exists): `DELETE FROM meeting_hours_block WHERE "meetingId" = M`** —
   both reasons, `had_entry` and `deleted` (AC-4.4, D66). Changed automatic entries and people's own entries stay (AC-3.6).
7. `UPDATE meeting_hours_meeting SET seq = notice.seq, "appliedAt" = now()` **and, when `facts = null`, `gone = true`**;
   commit, `200 { applied: true }`. The version row is kept: it names no person (A46) and it is what refuses a late notice.

The partial unique index `(userId, sourceMeetingId)` is the database's guarantee of "never twice"
(AC-4.2); the row lock makes it unreachable in practice.

**Why a later, repeated or out-of-order notice still records nothing for a deleted meeting (AC-4.5).** Two guards, either
sufficient: (a) by construction of the sender, every notice built after a deletion carries `facts: null` (`delivery.ts:69-70`,
`:88`: a `deleted` row, or a meeting that no longer exists), and every notice built before it carries a lower `seq` than the
deletion's (the deletion bumps `hoursSeq` last, and a deleted meeting is never written again), so with `facts: null` nobody is
desired and an older `seq` is ignored; (b) hours-api does not rely on (a): once `gone`, step 2 refuses every notice before
anything is read. (b) matters because step 6b dropped the blocks that kept deleted entries from returning: without it a
notice with facts and a higher `seq` — which meetings-api never sends — would record again what people deleted.

**The person's writes** (the only other writers of these rows):
- PATCH (`src/entries/entries.routes.ts:351-363`): every successful PATCH also sets
  `followsMeeting = false` (A39: any saved change). A refused PATCH writes nothing, so the entry stays
  untouched (AC-2.4). It never writes `origin` (AC-2.7 and A47 read it) and takes no version lock.
- DELETE (`:384-412`, **amended**): one interactive transaction, locking in apply's order (the meeting's version row, then
  the entry), so no deadlock:

  ```ts
  const found = await tx.timeEntry.findFirst({ where: { id, userId }, select: { sourceMeetingId: true } });
  if (found === null) return false;                                     // not the caller's: the existing 404 / 403 owner_only
  let gone = false;
  if (found.sourceMeetingId !== null) {                                  // an automatic entry; its source never changes
    const rows = await tx.$queryRaw<{ gone: boolean }[]>`
      SELECT "gone" FROM meeting_hours_meeting WHERE "meetingId" = ${found.sourceMeetingId} FOR SHARE`;
    gone = rows[0]?.gone ?? false;                                       // no row: write the block (fail toward AC-2.5)
  }
  const removed = await tx.timeEntry.deleteMany({ where: { id, userId } });
  if (removed.count === 0) return false;                                 // removed in another tab meanwhile
  if (found.sourceMeetingId !== null && !gone)
    await tx.meetingHoursBlock.createMany({ data: [{ meetingId: found.sourceMeetingId, userId, reason: "deleted" }], skipDuplicates: true });
  return true;
  ```

  While the meeting is live the block commits with the delete (AC-2.5), exactly as before. `FOR SHARE` waits for a running
  apply of that meeting (which holds the row `FOR UPDATE`) and holds a later one off until the delete commits, so a delete
  racing the deletion's apply either commits first (its block is then dropped by step 6b) or sees `gone` and writes none:
  either way no block survives the deletion (AC-4.4). Two deletes share the lock. A delete of an entry typed by hand
  (`sourceMeetingId` null) takes no lock, as before; apply's one-statement read (step 4) still covers it.
- POST is unchanged: an entry a person records on a meeting by hand is `origin: person`.

`since` is `meeting_hours_release.since`, written once by hours-api's migration as the Zurich date of
the day it runs (the release day, AC-1.5) — never configuration, so no environment can set it wrong.

### Refused service credentials (amendment: AC-5.1, AC-5.2, D64, D72)

**Where.** The shared region `systemAuth` of `src/auth/systemAuth.middleware.ts` (hours-api `:23-116`), byte-identical in
crm-api, estimai-api, activities-api, accounting-api, meetings-api and hours-api (`scripts/check-shared-copies.ts:81-91`), changed
in all six in **one commit** so `mise run shared:check` stays green (D72). Today the two checks that run after `jwtVerify`
succeeded — the `sub` allowlist (`:92-100`) and the scope (`:102-103`) — return the 401 silently, while every verification
failure logs `[system-auth] verification failed: <code>` (`:107-110`).

**The change**, inside the region (the helper takes the request's method and path, so the region needs no new import):

```ts
/**
 * A credential that VERIFIED (signature, issuer, audience, expiry) and is still refused is recorded for the operators
 * (specs/20261112-meeting-hours AC-5.1): which check refused it and the service it names — a `system:` sub, written by auth into
 * the credential it signed, capped at 80 characters; any other sub is not named (`service: null`), so a user id never reaches a
 * log. Never the token, the scope claim or any other claim. An object payload, so no value can forge a line. The caller gets
 * the same 401 as for every other failure (AC-5.2): nothing here changes the answer.
 */
const refusedVerified = (method: string, path: string, reason: "sub_not_allowed" | "scope_missing", sub: unknown): Response => {
  console.warn("[system-auth] refused", {
    reason,
    service: typeof sub === "string" && sub.startsWith(SERVICE_SUB_PREFIX) ? sub.slice(0, 80) : null,
    method,
    path,
  });
  return unauthorized(path);
};

// in the middleware, replacing the two silent returns:
if (typeof sub !== "string" || !sub.startsWith(SERVICE_SUB_PREFIX) || sub.length === SERVICE_SUB_PREFIX.length || !opts.allowedSubs.includes(sub))
  return refusedVerified(c.req.method, c.req.path, "sub_not_allowed", sub);
const scope = payload["scope"];
if (typeof scope !== "string" || !scope.split(" ").includes(opts.scope))
  return refusedVerified(c.req.method, c.req.path, "scope_missing", sub);
```

**The log line, exactly:** `console.warn("[system-auth] refused", { reason: "sub_not_allowed" | "scope_missing", service:
string | null, method: string, path: string })`. A credential failing both checks reports `sub_not_allowed` (the first). `path`
is the request path without its query string, as the accepted line already logs it (`:106`). `service` uses the key name
`service`, never `caller`, so the existing tests and runbook greps that read `caller=` as "an accepted call" keep that meaning.
Unchanged: no line for a missing header, a non-Bearer scheme or an empty token (no credential at all); the `verification
failed` line for an unsigned, forged, expired or wrongly addressed one (A44).

**The answer is unchanged byte for byte (AC-5.2):** the same `unauthorized(path)` body and status; nothing reaches the handler,
so nothing is written. Log volume is one line per refused request, no more than the `verification failed` line an anonymous
caller can already cause, and this one needs a credential auth signed.

**Who is affected:** every `/system` route guarded by a copy in the group, not only the notices channel (D72): crm-api's five
(companies, deals, contacts, estimate notices, meeting-host notices), estimai-api's deal-link notices, activities-api's
`/system/v1/*`, accounting-api's two reads, meetings-api's hosts route and hours-api's notices route. **Not affected, and
refusing silently as before:** three guards outside the group — notify-api's (`notify-api/src/system/systemAuth.middleware.ts`),
projects-api's (`projects-api/src/system/systemAuth.middleware.ts`, `GET /system/purchase-orders`) and estimai-api's second guard
(`estimai-api/src/system/systemAuth.middleware.ts`, `GET /system/estimates/{id}/summary`) — and auth's own `/system` routes. D72
names the six copies, so this plan does not reach them; bringing them in is a separate decision for the owner (R17).

### Release backfill

meetings-api's migration, after creating the table and job kind, enqueues one notice (and job) for
every meeting with `durationMs > 0` and `startsAt >= now() - interval '14 days'`, setting its
`hoursSeq` to 1. hours-api's `since` filters out what is older than its own release day. This covers
the meetings processed on the release day before meetings-api's deploy, and any gap of up to two weeks
between the two services' deploys, with no operator step. Rejected: an operator-run script (a
forgotten step silently loses the release day's meetings); a backfill keyed on hours-api's `since`
(meetings-api cannot know it).

**Known, accepted limit (decisions T8):** the backfill queues only the immediate delivery, never A37's second one
(§ Where meetings-api records a notice). A meeting that has a duration and whose Zurich day is still after today when
the migration runs (one already recorded or uploaded whose start was set to a later day, which is rare) is delivered
once, hours-api creates nothing for a day after today, and nothing sends it again when that day comes. Its entries
appear only at its next change of a hours fact (start, duration or Operai participants; that notice carries its own A37
delivery if the day is still ahead), and never if no such change comes. Each person can still record those hours by
hand. Not repaired: the migration has already run on the development database (decisions T12), a migration a database
has applied is never edited (ADR 20261119-data-that-moves-…-an-applied-migration-is-never-edited), and no further
migration is planned for so rare a case. (Ledger D71.) The backfilled meetings were processed before this release, so their
held durations are not measured again (R16).

### Deploy order

0. **`HOURS_API_URL` on meetings-api, before the merge**: hours-api's private address and port, never its public
   domain (the service token travels in this call). meetings-api's production `env.ts` lists it in
   `PRODUCTION_REQUIRED_KEYS` and exits 1 at start without it, so a meetings-api of this release cannot start until it
   is set, while the running, older code ignores it. It is a precondition of meetings-api's deploy, not a step after it
   (`infra/README.md` § Meeting hours release, Step 0). For the same reason it is never unset to pause the channel:
   the pause is removing the scope from the `SERVICE_CLIENTS` entry.
0a. **(amendment) Identifier check, read-only, before the merge (A45, R10).** On production, each must return 0:
    auth `SELECT count(*) FROM "user" WHERE id !~ '^[A-Za-z0-9_.:-]{1,64}$'`; meetings
    `SELECT count(*) FROM meeting WHERE id !~ '^[A-Za-z0-9_.:-]{1,64}$' OR "creatorUserId" !~ '^[A-Za-z0-9_.:-]{1,64}$'` and
    `SELECT count(*) FROM meeting_participant WHERE "userId" IS NOT NULL AND "userId" !~ '^[A-Za-z0-9_.:-]{1,64}$'`. A non-zero
    count stops the release: the set is widened (never the refusal) in both wire copies first (A45).
1. **auth** with the new scope known; only once it is live, add `meeting-hours-notices.send` to the
   `meetings-api` entry of production `SERVICE_CLIENTS` (an unknown scope stops auth, ADR 20261108-crm-pushes-deal-links-to-estimai).
2. **hours-api** and **meetings-api** in either order: notices sent before hours-api has the route get
   404, which is transient, and are delivered once it exists; `since` is hours-api's own release day. **(amendment)** hours-api's
   two migrations (`20261124093525_meeting_hours` and `<ts>_meeting_hours_gone`) reach production in the same deploy — production
   has neither (R14). The measured duration and the wire's id pattern need no order (§ Identifiers on the wire, version skew).
3. **hours-ui** any time: a `TimeEntryView` without `origin` (an older hours-api) reads as `person`; the mark's new condition is
   client-only.
4. **(amendment) crm-api, estimai-api, activities-api, accounting-api** any time, in any order: their only change is the refusal
   log line, every answer is byte-identical. They redeploy with the merge. New changeset
   `.changeset/system-auth-refusal-log.md`: `@operai/crm-api`, `@operai/estimai-api`, `@operai/activities-api`,
   `@operai/accounting-api`, `@operai/meetings-api`, `@operai/hours-api`, all **patch** (one cross-app changeset, AGENTS.md; the
   feature changeset's minor wins for meetings-api and hours-api). The feature changeset
   (`.changeset/meeting-hours-automatic-entries.md`) is reworded for the mark ("while it is recorded on a meeting"), the measured
   duration (meetings-api) and the blocks dropped at deletion and the id pattern (hours-api).

### Decisions this plan makes

- **D-P1 Facts are pushed by their owner as a versioned state built at send time**, through an
  until-delivered outbox; hours-api applies only a version not older than the one it holds. Rejected:
  (a) a content-free notice plus a read-back route in meetings-api (`GET /system/meetings/attendance`):
  a second route, scope and hop, and two concurrent read-backs can still apply out of order, so it needs
  the same version anyway; (b) deriving automatic entries on read from meetings-api: every total,
  export and Everyone's hours would depend on Meetings answering, the "a total that looks complete
  while it is not" failure of ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route; (c) a change feed hours-api pulls on a timer: a
  commit-order cursor misses rows from concurrent transactions and needs deletion tombstones and a
  scheduler in hours-api; (d) coalescing pending notices per meeting: a notice already being delivered
  may have read the facts before the change it would absorb (lost update). → ADR
  `docs/adr/20261124-meeting-hours-facts-pushed-by-their-owner-as-a-versioned-state-built-at-send-time-through-an-until-delivered-outbox-and-applied-by-hours-api-only-when-not-older.md`.
- **D-P2 An automatic entry is a person's own `time_entry` that Operai wrote**, follows its meeting
  only while `followsMeeting` is true (cleared by any saved change), and is kept from coming back by a
  `meeting_hours_block` row (deleted / had an entry). Rejected: comparing values to decide "untouched"
  (a person who sets back the same duration would be followed again); a soft-deleted `time_entry` as the
  tombstone (every reader of `time_entry` would have to skip it); recreating after a delete while the
  person has no entry (D55). → ADR
  `docs/adr/20261124-a-system-written-time-entry-follows-its-source-fact-only-until-its-person-changes-it-and-is-never-written-again-after-the-person-removed-it.md`.
- **D-P3 A38 is enforced where participants are added**: meetings-api already refuses a participant
  whose account is not active (`participants.routes.ts:80-87`), and a creator is active when creating;
  hours-api does not re-check liveness when the duration becomes known (it has no service path to
  `auth`'s identities, which needs a user's token). A person deactivated between being added and the
  meeting's end gets an entry no one but read-all holders will see. **Confirmed by the owner at plan
  review, 2026-11-24 (ledger D58).**
- **D-P4 `durationMs = 0` is "not known"** (a recording whose stored chunks report no audio): no entry,
  rather than A36's 30-minute floor for a meeting nobody spoke in. **Confirmed by the owner at plan
  review, 2026-11-24 (ledger D59).**
- **D-P5 (rewritten by the amendment) The mark is shown wherever entries are listed one by one, Everyone's hours included**
  (`EntryRow`, `EntriesTable`; AC-2.3, D62), **under one rule: `origin === 'meeting' && on.type === 'meeting'`** (D67, A47;
  design S1), one predicate both screens call so they cannot drift. The delete sentence keeps `origin === 'meeting'` alone
  (AC-2.7, D70): two predicates on purpose, and the wire must keep `origin: meeting` on a moved entry for it. The export file is
  unchanged (no column added to D39/D40's nine). Rejected: the first rule (`origin` alone, D57/D62: a read-all holder learned
  from the mark that a person attended a meeting whose hours they had recorded elsewhere, review I8, design G6); deriving the
  condition on the server (a second `TimeEntryView` field for a fact the client already has); recomputing `origin` on a move
  (AC-2.7's sentence would then lie about what the deletion does, D70).
- **D-P6 (amendment) The measured duration is decided in `prepare_audio`'s one commit, by one pure integer rule
  (`durationAfterMeasure`), from the held duration read under the meeting's row lock, before the meeting leaves `processing`**
  (AC-3.8–AC-3.10, D63, design G7). Rejected: always taking the measured one (A42: timer noise would resize entries and
  re-announce every recording); never correcting (review L1: a claimed duration stands even when the audio says otherwise);
  failing a meeting whose two figures differ (an honest glitch would lose its meeting); a float percentage (an edge vector would
  depend on rounding); deciding in `transcribe` or after `ready` (an open page keeps the held figure, G7); a second notice path
  (the existing compare already announces a changed duration).
- **D-P7 (amendment) A deleted meeting keeps only its version row, marked `gone`**: applying `facts: null` drops every block of
  the meeting in the same transaction and sets `gone`; a `gone` meeting takes no further notice; the person's DELETE of an
  automatic entry takes the meeting's version row `FOR SHARE` and writes no block once `gone` (AC-4.4, AC-4.5, D66, A46).
  Rejected: the review's one line alone (`deleteMany` of blocks on `facts: null`: a person who deletes a changed entry after the
  meeting's deletion would write a fresh block, which AC-4.4 forbids); reading `gone` without the lock (a delete committing
  beside the apply leaves a block); dropping the version row too (a late older state would recreate entries — ADR
  20261124-meeting-hours-facts-pushed-…'s "deletion is a state too"); a sweep of blocks of deleted meetings (hours-api cannot tell
  them from live ones without `gone`, and the suite derives or acts in the owning transaction, never sweeps, ADR
  20260714-invitation-lifecycle-derived-expiry-state).
- **D-P8 (amendment) A refused but verified service credential is logged in the shared guard, with its reason and the `system:`
  service it names, never a user-shaped sub, the token or another claim, as an object payload** (AC-5.1, AC-5.2, D64, D72).
  Rejected: hours-api alone (its copy would leave the shared-copies group, D72); a 403 for a verified credential that is not
  allowed (tells the caller its credential is valid, AC-5.2); logging the scope claim or a token fingerprint (the record must
  contain nothing of the credential, AC-5.1); a template string (a claim value could shape the line); alerting or a counter
  (spec non-goal).
- **D-P9 (amendment) A45 is resolved as proposed: `[A-Za-z0-9_.:-]`, 1..64**, confirmed against every generator of an id that
  reaches the wire (§ Identifiers on the wire) and checked read-only in production before the merge. Rejected: a tighter set per
  field (a cuid-only `meeting.id` would refuse the backfill's uuids and any future generator, and a refusal is final);
  `\w`-style Unicode classes (letters outside ASCII are never generated and would reach the logs).
- **D-P10 (amendment) A duration correction is logged for the operators** — `[prepare_audio] duration_corrected` with the meeting
  id and the held and measured milliseconds, after the commit, only when a held duration was replaced; no user id, no title.
  It is R9's early signal (how often, and by how much, honest recordings are corrected). Not shown to anyone in the app
  (A43). *Strike it to log nothing; then R9 has no signal after release.*

## Data model

### meetings-api — migration `<ts>_hours_notice`

```prisma
model Meeting {
  // … unchanged …
  /// Version of the hours facts (startsAt, durationMs, Operai participants) last announced to hours-api
  /// (specs/20261112-meeting-hours). Bumped in the transaction that changes one of them.
  hoursSeq Int @default(0)
}

enum HoursNoticeKind  { state  deleted }
enum HoursNoticeState { pending  failed }

/// Until-delivered outbox to hours-api. No FK to meeting: a `deleted` notice outlives its meeting.
/// Holds no personal data: the facts are read when it is sent.
model HoursNotice {
  id            String           @id @default(cuid())
  meetingId     String
  seq           Int
  kind          HoursNoticeKind
  state         HoursNoticeState @default(pending)
  attempts      Int              @default(0)
  lastErrorCode String?
  createdAt     DateTime         @default(now())
  @@index([meetingId])
  @@map("hours_notice")
}

enum JobKind { prepare_audio  transcribe  summarize  deliver_host_notice  deliver_hours_notice }
```

- `MeetingJob` unchanged; the job carries `noticeId` (no FK), never `meetingId` — a `meetingId` would be
  cascaded away with the meeting (FK cascade, `schema.prisma:470`).
- Backfill (same migration, after the DDL): for meetings with `"durationMs" > 0 AND "startsAt" >= now()
  - interval '14 days'`: `hoursSeq = 1`, one `hours_notice` (`seq 1`, `state`) and one `meeting_job`
  (`deliver_hours_notice`, `queued`, `runAfter now()`, `maxAttempts 1000000`, ids from
  `gen_random_uuid()::text`).
- `src/jobs/runner.test.ts:567-569` (the pinned kinds) and the exhaustive handler table
  (`src/jobs/handlers/index.ts:11-16`) gain the kind; `routeKit.reset()` truncates `hours_notice`.
- **(amendment) No meetings-api migration** for the additions: the measured duration writes the existing `durationMs`.

### hours-api — migration `<ts>_meeting_hours`

```sql
CREATE TYPE "TimeEntryOrigin" AS ENUM ('person', 'meeting');
ALTER TABLE time_entry
  ADD COLUMN "origin"          "TimeEntryOrigin" NOT NULL DEFAULT 'person',
  ADD COLUMN "sourceMeetingId" TEXT,
  ADD COLUMN "followsMeeting"  BOOLEAN NOT NULL DEFAULT false;
-- an automatic entry remembers its meeting, even once moved elsewhere by its person
ALTER TABLE time_entry ADD CONSTRAINT time_entry_origin_shape
  CHECK (("origin" = 'meeting') = ("sourceMeetingId" IS NOT NULL));
-- only an automatic entry still on its meeting, with no note, can follow it
ALTER TABLE time_entry ADD CONSTRAINT time_entry_follows_shape
  CHECK (NOT "followsMeeting" OR ("origin" = 'meeting' AND "target" = 'meeting'
         AND "meetingId" = "sourceMeetingId" AND "note" IS NULL));
-- one automatic entry per meeting and person, ever (AC-4.2)
CREATE UNIQUE INDEX time_entry_one_automatic_per_meeting
  ON time_entry ("userId", "sourceMeetingId") WHERE "sourceMeetingId" IS NOT NULL;

-- the newest version of each meeting's facts applied (D-P1)
CREATE TABLE meeting_hours_meeting (
  "meetingId" TEXT PRIMARY KEY,
  "seq"       INTEGER NOT NULL CHECK ("seq" >= 0),
  "appliedAt" TIMESTAMP(3)
);

-- a person who must never get an automatic entry on a meeting (AC-1.4, AC-2.5)
CREATE TYPE "MeetingHoursBlockReason" AS ENUM ('had_entry', 'deleted');
CREATE TABLE meeting_hours_block (
  "meetingId" TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "reason"    "MeetingHoursBlockReason" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("meetingId", "userId")
);

-- the release day (AC-1.5): one row, written here, never by configuration
CREATE TABLE meeting_hours_release (
  "id"    SMALLINT PRIMARY KEY CHECK ("id" = 1),
  "since" DATE NOT NULL
);
INSERT INTO meeting_hours_release ("id", "since")
  VALUES (1, (now() AT TIME ZONE 'Europe/Zurich')::date);
```

Existing rows get `origin = person`, no source, not following — every existing CHECK still holds. The
migration must apply cleanly in `src/migration.seed.test.ts`'s throwaway schema; `src/db.constraints.test.ts`
asserts the two new CHECKs and the unique index by name.

### hours-api — migration `<ts>_meeting_hours_gone` (amendment: AC-4.4, AC-4.5, D-P7)

A new migration, never an edit of `20261124093525_meeting_hours`, which development databases have applied (ADR
20261119-data-that-moves-…-an-applied-migration-is-never-edited):

```sql
-- A meeting whose deletion hours-api applied (specs/20261112-meeting-hours AC-4.4, AC-4.5): its blocks were dropped with it and
-- no later notice changes anything. Names no person (A46).
ALTER TABLE meeting_hours_meeting ADD COLUMN "gone" BOOLEAN NOT NULL DEFAULT false;
```

```prisma
model MeetingHoursMeeting {
  meetingId String    @id
  seq       Int
  appliedAt DateTime?
  /// The meeting's deletion was applied: its blocks are gone and no notice applies any more (AC-4.4, AC-4.5).
  gone      Boolean   @default(false)
  @@map("meeting_hours_meeting")
}
```

No data step. In production it runs in the same deploy as `20261124093525_meeting_hours`, before any notice exists, so there is
no block of a deleted meeting to clear (A46's case does not arise; R14). On a development database that already holds blocks of
meetings deleted before this migration, those meetings cannot be told from live ones (no `gone` was recorded) and their blocks
stay: development data only. `src/db.constraints.test.ts` asserts the column, its default and that an existing row reads `false`.

## API contracts

### hours-api — `POST /system/meeting-hours/v1/notices` (new)

```
Authorization: Bearer <service JWT>
  // createSystemAuthMiddleware({ scope: "meeting-hours-notices.send", allowedSubs: ["system:meetings-api"] })
  // RS256 via AUTH_JWKS_URL, issuer AUTH_ISSUER, aud = SERVICE_AUDIENCE. Every failure — none, a user JWT,
  //   another aud / iss / key / scope / sub (another service client holding the scope included), expired,
  //   malformed, a non-Bearer scheme — is the same 401, byte for byte. Checked BEFORE the body.
  // Attached per route (createRoute({ middleware })), never use("*"); the router is mounted before jwtMiddleware.
  // (amendment) A verified credential refused for its sub or scope also logs one `[system-auth] refused` line (below).

Request (strict: an unknown key anywhere is a 400)
{
  noticeId: string,                  // 1..64 of [A-Za-z0-9_.:-] (amendment, AC-5.3); logged, not stored
  meeting: {
    id:  string,                     // 1..64 of [A-Za-z0-9_.:-]
    seq: integer,                    // 1..2147483647
    facts: null                      // the meeting no longer exists
         | {
             startsAt:       string,          // ISO 8601 date-time WITH offset
             durationMs:     integer | null,  // 0..2147483647; null = not known
             creatorId:      string,          // 1..64 of [A-Za-z0-9_.:-]
             participantIds: string[]         // 0..100 distinct, each 1..64 of [A-Za-z0-9_.:-]; Operai participants only
           }
  }
}

200 { applied: boolean }   // false: an older version than the one applied, or (amendment) a meeting whose deletion was
                           //   applied (`gone`) — nothing changed either way; the sender settles the row on both
400 problem+json invalid_request { field }   // a JSON body the wire refuses: a missing or unknown key, a value out
                                             //   of bounds, (amendment) an id with a character outside the set (`field`
                                             //   names the first; no value is echoed); malformed or empty JSON is the
                                             //   same 400 without `field` — the sender treats it as permanent
401 problem+json (one body)
413 problem+json           // over the global 64 KiB body cap (src/index.ts, every route), decided BEFORE the guard
415 problem+json           // a body not declared as JSON (Hono, as on every hours-api route), decided after the guard
500                        // database failure — the sender retries (a NUL in an id no longer reaches here: 400)
```

Order of the answers: the body cap (413), the guard (401), the media type (415), the wire (400), then `apply()`. The
cap (`bodyLimit`, `src/index.ts:44-51`) is global and runs before the route's guard, parsing nothing: a declared
`Content-Length` over 64 KiB is refused from the header without reading the body, and a body sent without a length
(chunked) is buffered up to the cap and refused once it passes it. Neither answer says anything about the credential.
meetings-api meets neither (it always declares JSON, and the wire's caps keep any notice far below 64 KiB); were one
to occur, the sender would treat it as transient (§ Delivering a notice).

Never in the body: a title, external participants, a host, any content (AC-4.1). No outbound call is
made while applying (AC-2.6: no notification). Logged per apply: `meeting_hours.applied` with
`meetingId`, `seq`, `applied`, and counts created / moved / removed / blocked — **(amendment) and `cleared`, the blocks dropped
by a deletion** — never a user id. The route's OpenAPI 200 description gains the `gone` meaning.

### hours-api — changed

- **`TimeEntryView`** gains `origin: "person" | "meeting"` (required). `src/openapi.contract.test.ts:159`
  and `:164` (the pinned key lists) and `view.test.ts` are updated. `followsMeeting` and `sourceMeetingId`
  are never returned: they decide what Operai does, not what the person sees. **(amendment)** `origin` stays `meeting` after
  any change, a move off the meeting included: the delete sentence (AC-2.7, D70) and A47 read it.
- **`PATCH /time-entries/{id}`**: request, rules and errors unchanged; a 200 now also means the entry no
  longer follows its meeting.
- **`DELETE /time-entries/{id}`**: request and errors unchanged; deleting an automatic entry also blocks
  it from coming back (AC-2.5) — **(amendment) unless its meeting's deletion was applied, then nothing is kept (AC-4.4)**; the
  handler may wait, for the length of one apply, on a running apply of that meeting.
- List, totals and export: unchanged contracts; automatic entries are rows like any other.

### meetings-api — outbound (new)

`sendHoursNotice(notice, tokens)` → the request above. Outcome mapping in § Delivering a notice. Env:
`HOURS_API_URL` (`src/lib/env.ts`): URL, required when `NODE_ENV=production`, default
`http://localhost:8090` otherwise; listed in env-doctor's manifest for meetings-api.

### Operator log lines (amendment; contracts for infra/README and the tests)

| Service | Line | When | Carries | Never |
|---|---|---|---|---|
| the six of the `systemAuth` group | `console.warn("[system-auth] refused", { reason, service, method, path })` | a verified credential refused by the `sub` allowlist (`sub_not_allowed`) or the scope (`scope_missing`) | the reason; the `system:` sub (≤ 80 characters) or `null`; method; path without query | the token, the scope claim, any other claim, a user id |
| meetings-api | `console.log("[prepare_audio] duration_corrected", { meetingId, heldMs, measuredMs })` | after a `prepare_audio` commit that replaced a held duration (not one that filled a null) | meeting id, two integers | user id, title, content |
| meetings-api | `[hours] meeting_hours.notice_refused meeting=<id or "invalid"> code=<code>` (changed) | a row refused for good | the meeting id when it matches the wire's id rule, else `invalid` | a malformed id raw, user id, body |

### auth — changed

```ts
// KNOWN_SERVICE_SCOPES
"meeting-hours-notices.send",
// - `meeting-hours-notices.send`: tell hours-api the current hours facts of a meeting (start, duration,
//   creator, Operai participants) through `POST /system/meeting-hours/v1/notices` (specs/20261112-meeting-hours).
//   Only meetings-api holds it; hours-api's sub allowlist names `system:meetings-api`.
```

Prescribed scopes of client `meetings-api`: `notifications.push host-notices.send meeting-hours-notices.send`
(the doc comment, its pinning test and env-doctor's manifest).

### hours-ui — changed

`TimeEntryView.origin?: 'person' | 'meeting'` (optional on the client: an older hours-api omits it,
read as `person`). **(amendment) The mark's rule** (design S1, AC-2.3 changed, D67):

```ts
// hours-ui/src/lib/fromMeetingMark.ts
import type { TimeEntryView } from './hoursApi.types'
/** AC-2.3: "From meeting" shows exactly while an automatic entry is recorded on a meeting — its own, another one, or one since
 *  deleted (`on.type` stays `meeting`). Not the delete sentence's rule, which reads `origin` alone (AC-2.7, D70). */
export const showsFromMeetingMark = (entry: Pick<TimeEntryView, 'origin' | 'on'>): boolean =>
  entry.origin === 'meeting' && entry.on.type === 'meeting'
```

For `showsFromMeetingMark(entry)` only (anything else, `origin` or `on` missing included, renders nothing new):
- `EntryRow` and `EntriesTable` render `<Badge tone="accent">{strings.entries.fromMeeting}</Badge>` — in `EntryRow` right
  after the kind badge, before the name; in `EntriesTable`'s On cell on the name line, before the name, outside the `<p>`
  lines its tests read (design S1, S2). en "From meeting", it "Da riunione" (D60). An entry moved to a project, a deal or other
  work draws the kind badge alone, with no wrapper, exactly as a typed entry.
- `DeleteEntryDialog` — **for `origin === 'meeting'`, not the predicate** — adds a second paragraph after the existing sentence,
  `strings.entry.delete.automaticNote`: en "Operai won't record it again from its meeting. You can still record hours
  yourself.", it "Operai non la registrerà di nuovo dalla riunione. Puoi comunque registrare le ore tu." (design S4, AC-2.7;
  shown for a moved entry too, D70).

## Test strategy

Levels: **U** unit (pure), **I-H** hours-api integration (real Postgres `hours_test`, `world.ts`/`hosts.ts`),
**I-M** meetings-api integration (real Postgres `meetings_test`, `routeKit`, `createRunner` with manual
`tick()`, a fake hours-api recording what it receives), **C** hours-ui component (Vitest), **E** e2e in
`shell/e2e/` (new `meeting-hours.spec.ts`, the real recorder with the fake microphone of
`meetings-capture.spec.ts`). **(amendment)** **B** bare-app guard test (in-process Hono, local RS256 key set, as the existing
`*/src/auth/systemAuth.middleware.test.ts`); **C-M** meetings-ui component (Vitest).

| AC | Level | Test |
|---|---|---|
| AC-1.1 | U, I-H, I-M, E | U: `desiredEntries` gives creator + each participant the Zurich day and rounded minutes. I-H: a notice with facts creates one `origin: meeting`, following entry per person, on the meeting. I-M: stop a recording / confirm an upload / `prepare_audio` filling a null duration each records one notice + job; the delivered body carries `startsAt`, `durationMs`, `creatorId`, `participantIds` and the current `hoursSeq`. E: a creator records a short meeting with one Operai participant; after Stop, once the notice is delivered, each opens (or reloads) My hours and sees a 30-minute entry on the meeting — never a live update (design G5). Still valid with AC-3.8 (§ The measured duration, last paragraph) |
| AC-1.2 | U, I-H | creator also in `participantIds` → one entry |
| AC-1.3 | U, I-H, I-M | U: `durationMs` null or 0 → nobody (D-P4). I-H: a notice with `durationMs: null` creates nothing; the next with a duration creates. I-M: a text meeting records no notice; `prepare_audio`'s too-long refusal records one whose facts carry `durationMs: null`, and I-H removes the untouched entries |
| AC-1.4 | I-H | a person with a hand-made entry on the meeting gets block `had_entry` and no automatic entry; after deleting the hand-made one, a newer notice still creates none |
| AC-1.5 | U, I-H | U: `day < since` → nobody. I-H: the migration's `since` is the Zurich date; a meeting starting the day before creates nothing |
| AC-1.6 | I-H | route matrix (`src/matrix.test.ts`): only `system:meetings-api` with the scope reaches the route; activities-api and crm-api are unchanged (no new caller exists) |
| AC-1.7 | I-H | a user JWT (admin, read-all holder) on the system route → the one 401; time-tracking's `owner_only` / 404 tests still pass; an applied entry's `userId` is the participant's |
| AC-1.8 | I-H | an automatic entry has no work type, passes the minutes CHECK, and on a meeting linked to a deal counts in `GET /time-entries/totals?groupBy=deal` for that deal |
| AC-2.1 | C, E | C: `TableView` cell sum and the List include an `origin: meeting` entry. E: as AC-1.1, in the table view and the List |
| AC-2.2 | I-H | `whose=all` list, totals and a `dealId` filter include automatic entries |
| AC-2.3 **(changed)** | U, C, I-H, E | U: `fromMeetingMark.test.ts`, the predicate's table — `meeting`×meeting → true; `meeting`×project, deal, none → false; `person`×meeting, missing `origin`, missing `on` → false. C: `EntryRow.test.tsx` (List and cell dialog) and `EntriesTable.test.tsx` (Everyone's hours) show the mark for an automatic entry on its meeting, **moved to another meeting**, **moved off and back onto a meeting**, and on a deleted meeting (`visibility: hidden`: "[Meeting] [From meeting] Not visible to you"); show **no mark, the kind badge alone and no wrapper**, for one moved to a project, a deal or other work, for `person` and for a missing `origin`; `TableView.fromMeeting.test.tsx` adds a moved entry whose cell dialog shows no mark; the tests asserting the first rule are inverted or replaced (design § What this changes in the built code: `EntryRow.test.tsx`'s "plain text" case and its block "the mark follows origin, not what the entry is on now", `EntriesTable.test.tsx`'s "stays on an entry the person moved…" and "marks an entry on other work"); `EntriesTable.test.tsx`'s `lines()` still read the same lines; the Italian tests stay as they are (meeting targets). I-H (**kept, required by AC-2.7/D70**): after a PATCH of day, minutes or note, and after a move to a project and back onto the meeting, the view still says `origin: meeting`. E: journey B (the unmoved row is marked, a typed one is not) unchanged |
| AC-2.4 | I-H | a PATCH of day, minutes or note on an automatic entry is saved and clears `followsMeeting`; a refused PATCH (future day, 45 min) changes nothing and the entry still follows; a later notice changes neither |
| AC-2.5 | I-H | DELETE of an automatic entry (touched or not) writes block `deleted`; newer notices — same facts, participant removed and re-added — never recreate it; **(amendment)** the 20-round DELETE-vs-apply race still ends with the block and no entry, now with the DELETE holding the version row `FOR SHARE` |
| AC-2.6 | I-H | applying makes no outbound HTTP call (`hosts.calls()` empty); hours-api has no notify client |
| AC-2.7 | C | `DeleteEntryDialog` for `origin: meeting` shows the second paragraph (en, it) after the existing sentence; for `person` and a missing `origin` the dialog's text is exactly today's; **(amendment)** for an entry moved to a project (no mark) the paragraph still shows — the existing case retitled to cite AC-2.7/D70 |
| AC-3.1 | I-H, I-M | I-H: newer notice with another `startsAt` moves the untouched entry's day. I-M: PATCH with a new `startsAt` records a notice; a title-only PATCH records none |
| AC-3.2 | I-H, I-M | I-H: a new `durationMs` resizes the untouched entry. I-M: the `prepare_audio` fill records a notice; **(amendment)** so does its correction (AC-3.9) |
| AC-3.3 | I-H, I-M | I-H: a participant missing from the newer facts loses the untouched entry and gets no block; the creator, absent from `participantIds`, keeps theirs. I-M: a participants PUT that changes the userId set records a notice; one that only changes externals records none |
| AC-3.4 | I-H, I-M | I-H: `facts: null` removes every untouched entry. I-M: DELETE writes a `deleted` notice in its transaction; it survives the cascade (no FK) and is delivered after commit, also via the `meeting:erase` path |
| AC-3.5 | I-H | a changed entry is untouched by newer notices with another day or duration; a concurrent apply and PATCH leave the PATCH's values (the `AND "followsMeeting"` CAS, driven by two connections) |
| AC-3.6 | I-H | a changed entry stays when its person is removed or `facts: null`; with the fake meeting removed, its view has `visibility: hidden`, no label |
| AC-3.7 | I-H | a person added in a newer version gets an entry, unless blocked `had_entry` or `deleted` |
| AC-3.8 **(new)** | U, I-M, C-M | U: `src/media/measuredDuration.test.ts` — held null → measured; held 0 / measured 20 min → measured; held 0 / measured 10 s → 0; held 4:00 / 4:30 → held (30 s is not more than the floor) and 4:31 → measured (the floor binds); held 60:00 / 66:00 and 54:00 → held (10 % is not exceeded) and 66:00.001, 53:59.999 → measured (10 % binds); held 3:00:00 / measured 12 s → measured; held 2:00:00 / 1:00:00 (shorter) → measured. I-M: `src/jobs/handlers/prepareAudio.measured.test.ts` (fake storage, injected `normalize` and `probe`): a recording holding 3 h measured at 10 min → `durationMs` 10 min, **`status` still `processing`**, `audioKey` set, `transcribe` queued, one `hours_notice`, `GET /meetings/{id}` answers `durationMs` 10 min (design G7, S5); an upload holding its container's 2 h measured at 1 h → corrected the same way; hours channel off → corrected, no notice; one `duration_corrected` line with the meeting id and the two figures and no user id. C-M: `meetings-ui/src/pages/MeetingPage.test.tsx` — a `processing` meeting polled twice whose second answer carries another `durationMs`: the Details' Duration line shows the new value, and nothing else on the card changes |
| AC-3.9 **(new)** | I-M, I-H | I-M: the notice the correction recorded is delivered to the fake hours-api with the measured `durationMs` and the next `seq`. I-H (`apply.test.ts`, one added case): a notice at the held 3 h (180 min each), then one at the measured 10 min: the untouched entry becomes 30 min, the entry its person changed keeps its values (with the existing AC-3.2 and AC-3.5 cases, the receiver's half) |
| AC-3.10 **(new)** | U, I-M | U: the within-margin vectors of AC-3.8, both directions, and held 44:00 / measured 46:00 → held (the two would round to 30 and 60 min). I-M (`prepareAudio.measured.test.ts`): held 10:00 measured 10:20 → `durationMs` unchanged, no `hours_notice`, no correction line; `normalize` throwing `audio_unreadable` on a recording holding 3 h → `failed`, `durationMs` 3 h, no notice (D69); a recording decoding past 3 h 1 min (`too_long`) → `failed`, held kept; an upload decoding past 3 h → `draft`, `durationMs` null, a notice with `durationMs: null` (existing `prepareAudio.refuse.test.ts` and the AC-1.3 I-M row stay green) |
| AC-4.1 | I-H | the automatic entry's `note` is null; the strict body refuses an extra `title` key (400) |
| AC-4.2 | I-M, I-H | I-M: fake hours-api answers 503 then 200 → the row is retried with the backoff and delivered once; a 400 settles it as `failed`; channel disabled → nothing recorded. I-H: the same notice twice and an older `seq` after a newer one → one entry, `applied: false` for the older; My hours loads with the meetings fake down (existing) |
| AC-4.3 | C | catalog parity (`catalogGaps`) and `noHardcodedStrings` cover the new string (the amendment adds none) |
| AC-4.4 **(new)** | I-H | `apply.test.ts`: a meeting with blocks `had_entry` and `deleted`, and blocks of another meeting → `facts: null` applied: no block of M is left, the other meeting's stay, the version row is kept with its `seq` and `gone = true`, changed and hand-made entries stay (AC-3.6), the log line says `cleared: 2`; then the person deletes their changed entry of M → 204 and no block; a DELETE of a changed entry racing the `facts: null` apply (two connections, the delete landing before, during and after the apply, 20 rounds, a statement timeout so a deadlock fails the test) → no block of M once both commit; a DELETE of an automatic entry of a live meeting still writes `deleted` (AC-2.5). The existing log-line test's expected objects gain `cleared` (`apply.test.ts:677-694`). Migration: `db.constraints.test.ts` asserts `gone` (default `false`, existing rows `false`), and `migration.seed.test.ts` applies both migrations |
| AC-4.5 **(new)** | I-H, I-M | I-H, after the deletion was applied: the same `facts: null` notice again → `applied: false`, nothing written; an older `seq` with facts → `applied: false`, no entry; a **newer** `seq` with facts naming the people who had deleted theirs or had their own (a notice meetings-api never sends, built by the test) → `applied: false`, no entry for anyone; through the route, each is a 200 the sender settles. I-M (existing AC-3.4 row, extended): a `state` row still pending when the meeting is deleted is delivered with `facts: null` at its own lower `seq` |
| AC-5.1 **(new)** | B, I-M, I-H | B in hours-api `src/auth/systemAuth.middleware.test.ts` (the test "what an accepted and a refused call log", rewritten): a token of `system:crm-api` holding the scope → exactly one `console.warn` call `["[system-auth] refused", { reason: "sub_not_allowed", service: "system:crm-api", method: "POST", path }]`; `system:meetings-api` without the scope → `{ reason: "scope_missing", service: "system:meetings-api", … }`; a verified token whose sub is not a service's (`user-1`, service audience) → `service: null`; a 200-character `system:` sub → logged at 80; a forged key, `alg: none`, an expired token and the user audience → only `verification failed: <code>`, no `refused` line; no argument of any call, stringified, contains the token, the scope string or another claim. B in crm-api and estimai-api (`src/auth/systemAuth.middleware.test.ts`, "a rejected call never logs the token or a caller line"): the same positive assertion added, the negative ones kept. One case each, through a route, in meetings-api (`src/system/hosts.routes.test.ts:343`, retitled "…a refused one logs the refusal, never a caller line"), activities-api (`src/system/system.test.ts`) and accounting-api (`src/system/system.routes.test.ts`): a `system:<other>` credential gets the 401 and one `refused` line. `mise run shared:check` green; the six services' full suites green |
| AC-5.2 **(new)** | B, I-H | B: the "same body" test of each middleware test file includes a sub not allowed, a scope missing and a non-service sub beside a forged key and no credential: one body. I-H (`notices.routes.test.ts`, matrix snapshot): both refusals leave `time_entry`, `meeting_hours_meeting` and `meeting_hours_block` unchanged. Every existing 401 test of the six services passes unchanged |
| AC-5.3 **(new)** | U, I-H, I-M | U: `hours-api/src/lib/meetingHoursWire.test.ts` — a NUL, `\n`, a space, `/`, `@`, `+`, `é` and a trailing `\n` in `noticeId`, `meeting.id`, `creatorId` and one `participantIds` element are each refused with the member named; `isMeetingHoursId` agrees. I-H (`notices.routes.test.ts`): the review's NUL probe, today a 500, is a 400 `invalid_request` whose body echoes no value, and nothing is written. I-M (`src/hours/delivery.test.ts`): a meeting whose Operai participant id holds a space (written directly) → its row `failed` `invalid_notice`, the fake hours-api received nothing, no job left queued for it; the meeting's next fact change records a notice refused the same way; a meeting id holding `\n` → the refusal line reads `meeting=invalid`; the client maps a 400 to permanent (existing) |
| AC-5.4 **(new)** | U, I-M | U (wire test): accepted — a 32-character better-auth id, a Prisma cuid (`c` + 24), a `gen_random_uuid()` text, a 64-character id, and ids with `-`, `_`, `.`, `:`; a 65-character id refused. I-M: the backfill's uuid notice is delivered (existing `delivery.backfill.test.ts` stays green). Every existing test of both services passes unchanged (their fixture ids are inside the set). Release: the pre-merge production counts are 0 (§ Deploy order 0a; a runbook step, not CI) |

Also: U vectors for A36 (1 ms → 30, 44:59.999 → 30, 45:00 → 60, 1:14:59 → 60, 1:15:00 → 90, 23:44:59 → 1410,
23:45:00 → 1440, 30 h → 1440) and A35 (23:30 UTC on a winter and a summer day). I-M for A37: a `startsAt`
on a later Zurich day enqueues a second job due at 00:01 Zurich that day; I-H: that day's re-delivery
(equal `seq`) creates the entry. `scripts/check-shared-copies.ts` covers the hours-api copy of
`systemAuth.middleware.ts`. auth: the scope-list and prescribed-scope tests. **(amendment)** The design's optional browser step
(edit the creator's entry onto other work → no mark; back onto the meeting → the mark; delete the moved one → the second
paragraph) is QE's choice at T11's next run; the rule is a pure function of two fields and the C rows carry it.

## Risks

- **R1 hours-api or the token unavailable for a long time** → automatic entries are late (AC-4.2
  accepts late, never lost). Early signal: `meeting_hours.notice_*` logs and the count of `hours_notice`
  rows older than an hour (one query, in the release runbook); the 30-minute cadence bounds the delay
  after recovery.
- **R2 A permanent 400 strands a notice** (a version gap in the body schema). Mitigation: the body's
  zod schema and caps live in one byte-identical file, `src/lib/meetingHoursWire.ts`, in both services
  (a `meetingHoursWire` group in `scripts/check-shared-copies.ts`, as `accountingWire`): meetings-api
  builds the body with it, hours-api parses with it. A `failed` row keeps its code, and the meeting's next
  fact change sends a fresh version. Early check: the shared-copies script in the first task.
- **R3 The release backfill window** (14 days) is shorter than the gap between the two deploys → older
  meetings of the release period are missed. Mitigation: deploy both in one release (§ Deploy order).
- **R4 `hours_notice` rows accumulate while the channel is misconfigured in production**. Mitigation:
  `HOURS_API_URL` and service credentials required at startup in production; env-doctor.
- **R5 `systemAuth.middleware.ts` copy may not compile in hours-api** (it imports `../lib/env` and expects
  `SERVICE_AUDIENCE`, `AUTH_JWKS_URL`, `AUTH_ISSUER`; hours-api has all three). Early check: first task
  compiles the copy and runs its bare-app test before any route uses it.
- **R6 A meeting moved to a far future day** keeps a delayed job queued until then. Harmless (one row);
  a later change sends a fresh version anyway.
- **R7 meetings-api raises its 30-participant cap above hours-api's 100** → 400, permanent (R2). Early
  check: the shared wire file carries the cap.
- **R8 hours-api's route mounted after `jwtMiddleware`** → every notice 401. Early check: the matrix test
  and an assembled-app test with a real service JWT.
- **R9 (amendment) The margin corrects honest recordings** (a systematic gap between the pieces a browser reports and the
  decoded audio — an interrupted and resumed session, a codec's padding — beyond max(30 s, 10 %)), and entries resize silently
  (design G7). Early check, before the merge: in development, record with the real recorder 2 min, 15 min and one interrupted
  and resumed session, and upload a 10-minute m4a and webm; expect no `duration_corrected` line (D-P10). After release, the
  same line's count. Mitigation: the margin is two constants in one pure function; raising it is a one-line change, decided
  with the owner (A42).
- **R10 (amendment) An identifier outside A45's set exists** → every notice of its meeting is refused for good and the whole
  meeting records no hours, silently. Evidence that none is generated: § Identifiers on the wire. Early check: § Deploy order
  0a's production counts; a non-zero count stops the release and widens the set.
- **R11 (amendment) The shared guard changes in six services' authentication path**: a mistake would break every `/system`
  route of the suite. Mitigation: the change adds one log call before the existing `return unauthorized(...)`, with no `await`
  and no new branch in what is returned; `shared:check`. Early check: the first task of the amendment runs the full suites of
  crm-api, estimai-api, activities-api, accounting-api, meetings-api and hours-api.
- **R12 (amendment) The refusal line as a flood or forgery vector.** It needs a credential auth signed for a configured client,
  so it is bounded by who holds a client secret; one line per request, no more than the `verification failed` line any caller
  can already cause; an object payload with the sub capped at 80. No early check needed beyond AC-5.1's B tests.
- **R13 (amendment) The DELETE of an automatic entry now waits on a running apply of its meeting** (one transaction, no
  outbound call: milliseconds). Deadlock is excluded by order (the version row, then the entry, as apply); PATCH takes no
  version lock. Early check: the AC-4.4 race test under a statement timeout and the existing AC-2.5 race test.
- **R14 (amendment) hours-api's first migration reaching a database without the second** keeps the blocks of meetings deleted
  in between, which cannot be identified later. Production: both migrations ship in one deploy. Early check, before the
  hours-api deploy: production has no `meeting_hours_block` table yet (`SELECT to_regclass('meeting_hours_block') IS NULL`).
- **R15 (amendment) A later change moves the correction after the meeting leaves `processing`** → an open Meetings page keeps
  the held figure (design G7). Early check: the AC-3.8 I-M test asserts `status = processing` with the corrected duration after
  `prepare_audio` alone.
- **R16 (amendment) Meetings processed before the release keep their held duration**, so the backfill's entries rest on a duration
  never measured. Accepted: 14 days, creator-trusted before, each person can change or delete; no reprocessing.
- **R17 (amendment) Three service-credential guards stay silent on a verified refusal**: notify-api's, projects-api's and
  estimai-api's summary-route guard are separate implementations outside the `systemAuth` group, so the suite records these
  refusals on the routes of the six services and not on those three. Not a defect of this spec (its channel is covered, D72 names six copies); an
  operator reading the logs must know the gap. Mitigation: infra/README § Meeting hours release lists which services log the
  line; folding the three into the group (or giving them the same line) is a separate owner decision, outside this plan.

## Security

**Security-sensitive: YES** — schedules an owasp-reviewer pass in parallel with QE. **(amendment)** The amendment changes an
authentication path shared by six services and a write path on personal data: an **owasp delta pass** over the surfaces named
below (the six guards' refusal line; the wire's id pattern in both copies; hours-api's DELETE handler with its lock and `gone`;
`apply()`'s `gone` guard and block drop; `prepare_audio`'s correction; hours-ui's predicate) is scheduled in parallel with QE.

- **New authentication path in hours-api**: its first route that accepts a service JWT. Verified exactly
  as meetings-api's system routes (shared middleware copy): RS256, issuer, `aud = SERVICE_AUDIENCE` (≠
  `AUTH_AUDIENCE`), scope `meeting-hours-notices.send`, `sub` allowlist `system:meetings-api`, one 401 for
  every failure, checked before the body. The matrix test fails on any unpinned `/system/` route.
- **(amendment) Refused credentials recorded, in every copy of the guard (AC-5.1, AC-5.2, D72).** Only after the signature,
  issuer, audience and expiry verified; the line names the check and a `system:` service auth wrote (a user-shaped sub is never
  named), never the token or another claim; object payload; the 401 unchanged byte for byte, so a caller still cannot tell a
  valid credential from a forged one. It detects a misconfigured or probing service client; it alerts on nothing and limits
  nothing (spec non-goals). The three guards outside the group (notify-api's, projects-api's, estimai-api's summary-route
  guard) and auth's `/system` routes are outside D72 and unchanged (R17).
- **Writes on a person's behalf** (D14 narrowed): only from facts the owner of the meeting states; only
  for the meeting's creator and Operai participants; only on the meeting; at most one per person and
  meeting (unique index); never after the person deleted it. No user, admin or read-all holder gains a
  write (AC-1.7).
- **Abuse by a meeting's creator**: they can add colleagues as participants and so give them hours on a
  meeting — the same trust Meetings already places in the creator's participant list (validated active,
  ≤ 30); each person can delete theirs. The creator also controls the two other facts an entry is built
  from:
  - **Duration.** A recording's held duration is the sum of the per-chunk durations the browser reports when it confirms
    each chunk (each ≤ 15 s, `MAX_CHUNK_MS`; the meeting's total ≤ `MAX_RECORDING_MS` = 3 h 1 min, a confirm past it
    refused, `meetings-api/src/capture/recording.routes.ts:33, :269`); an upload's is the container's own claim as ffprobe
    reads it (≤ `MAX_AUDIO_MS` = 3 h, refused beyond, `src/media/probe.ts:34`). **(amendment, D63)** When processing
    succeeds, the held duration is replaced by the measured length of the decoded audio if they differ by more than
    max(30 s, 10 %) (§ The measured duration), so a claimed duration no longer stands against readable audio: the entries
    built at Stop follow the measured one while untouched. **What stays creator-trusted:** the held duration between Stop
    and the end of processing (minutes); a difference within the margin (≤ 10 %); and audio that cannot be read at all —
    the review's forged-pieces case (about 722 one-byte chunks at a reported 15 s each) fails processing as
    `audio_unreadable`, and its held duration and the entries built on it stay (D69, spec non-goal). An automatic entry is
    therefore still at most **180 minutes** per person and meeting (A36's rounding of 3 h 1 min); A36's 24-hour clamp is
    never the binding bound.
  - **Start.** `startsAt` is set at create (default now) or by a PATCH (`src/meetings/core.routes.ts:129, :201`), to
    any instant. It decides the day of every participant's entry, bounded by the release day (AC-1.5) and today
    (A37), and a PATCH moves every untouched entry with it. Not checked against anything (spec non-goal).

  So a forged client gains nothing that recording 3 h of real silence with 30 colleagues does not already allow: at
  most 3 h for each of at most 31 people per meeting, on a day of the creator's choosing within those bounds. Each
  participant is notified when added, sees the entry marked "From meeting", and can change it, or delete it for good. The
  creator-trust model of AC-1.7 and D54–D57 stands (security review L1, low; the optional hardening is now in scope as D63).
- **(amendment) Identifiers on the wire (AC-5.3, D65).** Every id is `[A-Za-z0-9_.:-]{1,64}` on both sides: a NUL or a control
  character is a permanent 400 (no more retry-forever 500, review I3), the 400 echoes no value, and the sender's refusal line
  never prints a malformed meeting id. The set is confirmed against every generator (D-P9) and checked in production before
  the merge (R10).
- **Personal data in transit**: attendance (who, when, how long) crosses services — the minimum the
  feature needs; no title or content (AC-4.1). The outbox stores no personal data (ids built at send);
  hours-api stores only what an entry already holds plus `meeting_hours_block` (meeting id, user id,
  reason). Logs carry no user id. **(amendment, AC-4.4, D66, review I6)** Once a meeting's deletion is applied, its blocks —
  who deleted an entry, who already had one — are dropped in that transaction, and a later DELETE writes none; what remains is
  the version row (meeting id, version, `gone`), which names no person, and the people's own entries (AC-3.6). The duration
  correction log carries a meeting id and two figures, no person (D-P10).
- **(amendment) The mark in Everyone's hours (design G6, review I8): superseded by D67.** The mark now shows only while an entry
  is on a meeting, so a `time-entry:read-all` holder no longer learns from it that a person attended a meeting whose hours they
  recorded elsewhere. What a holder can still read is what they always could: the entries on a meeting, and that such an entry
  was recorded by Operai. `origin` still reaches the client for a moved entry (the delete sentence, D70); it is shown to its
  person only, in their own delete confirmation.
- **Labour-law go-live sign-off (spec O3, accepted as risk)** — automatic recording of hours about a
  person: management / HR before go-live.
- No new external host, no data-residency change, and (amendment) no new reader of bytes: the measured duration is the one
  ffprobe already returned.

## ADR candidates

1 and 2 were written 2026-11-24 (paths in § Decisions this plan makes) and indexed in AGENTS.md. 3 to 6 come from the amendment
for the security-review additions; each names what it rejects.

1. **A meeting's hours facts reach hours-api as a versioned state its owner builds at send time,
   through an until-delivered outbox, and hours-api applies only a version not older than the one it
   holds** (D-P1), with the release backfill enqueued by meetings-api's migration and filtered by
   hours-api's migration-stamped release day. Rejected: read-back route, derived-on-read entries, pull
   feed, coalescing; an operator-run backfill script.
2. **A record that is a person's own declaration may be written by the system only from a fact its
   owner states, follows that fact only until the person changes it, and is never written again once
   the person removed it** (D-P2, D14 narrowed by D54–D56). Rejected: value comparison for "untouched",
   a soft-delete tombstone in `time_entry`, recreation after delete.
3. **(new ADR) A correctly signed service credential refused for its service or its scope is logged with the reason and the
   service it names, in every copy of the shared guard, and the caller still gets the one identical 401** (D-P8, D64, D72).
   Rejected: hours-api's copy alone (it would leave the shared-copies group and the suite with two guards); a 403 for a verified
   but unallowed credential (tells a prober its credential is valid); logging the scope claim or a token fingerprint; alerting
   or limiting. Constrains every future `/system` route (it inherits the line) and every future copy of the guard; it must say
   that notify-api's, projects-api's and estimai-api's summary-route guards are outside the group and do not log it (R17). Predicted
   path: `docs/adr/20261124-a-correctly-signed-service-credential-refused-for-its-service-or-scope-is-logged-with-the-reason-and-the-service-it-names-and-the-caller-still-gets-the-one-401.md`.
4. **(amendment of ADR 20261124-a-system-written-time-entry-follows-its-source-fact-only-…)** Three points of its Consequences
   change: (a) the "From meeting" mark follows the entry's current target (`origin === 'meeting' && on.type === 'meeting'`),
   while `origin` itself is still never recomputed because the delete sentence and A47 read it (D-P5, D67, D70) — rejected:
   the mark on `origin` alone (D57/D62, review I8), recomputing `origin` on a move; (b) "the block insert in every DELETE path"
   becomes "unless the meeting's deletion was applied, under a `FOR SHARE` lock on the meeting's version row" (D-P7, D66) —
   rejected: writing the block regardless (a record AC-4.4 forbids), checking `gone` without the lock (a race leaves a block);
   (c) its risk "a forged duration is capped by the stored recording chunks and the 24 h entry cap" is wrong (review L1) and is
   replaced by § Security's duration bullet with D63. Path: the existing file, an `## Amendment 2026-11-24` section.
5. **(amendment of ADR 20261124-meeting-hours-facts-pushed-by-their-owner-…)** (a) "the consumer must keep the tombstone it
   applied" is made precise: it keeps the version row, marks it `gone`, drops every per-person block of the meeting in the same
   transaction, and applies nothing after it, whatever the version (D-P7, D66, A46) — rejected: keeping the blocks (review I6),
   dropping the version row too (a late older state recreates entries), relying on the sender's versions alone once the blocks
   are gone; (b) every identifier on the wire is `[A-Za-z0-9_.:-]{1,64}`, so a value the receiver's store cannot hold is a
   permanent 400 at the wire, never a database 500 the sender retries (D-P9, D65) — rejected: letting Postgres refuse it,
   a per-field tighter set (a final refusal must never meet a real id). Path: the existing file, an `## Amendment 2026-11-24`
   section; its Risks line "A permanent 400 … strands a meeting" gains "the whole meeting, for a malformed id in its facts".
6. **(new ADR, the lightest of the four; may be folded into 5 if the owner prefers) A figure a client reports and the server
   can measure is replaced by the measurement when they differ by more than noise — the larger of 30 s and 10 % — decided once,
   in the transaction that has the measurement, before the record leaves the state its readers watch** (D-P6, D63, design G7).
   Rejected: always replacing (noise resizes entries), never replacing (review L1), refusing the record on a mismatch (an honest
   glitch loses it), deciding after the watched state ends (stale open pages). Predicted path:
   `docs/adr/20261124-a-duration-a-client-reports-is-replaced-by-the-one-the-server-measures-when-they-differ-by-more-than-the-larger-of-30-seconds-and-10-percent.md`;
   referenced from § The measured duration.
