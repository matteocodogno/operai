---
spec: 20261112
status: approved
approved: 2026-11-24
---

# Plan: Meeting hours — the hours of a meeting recorded automatically for the people who took part

Spec: `specs/20261112-meeting-hours/spec.md` (approved 2026-11-24 at 25 acceptance criteria; the security review's additions took
it to 34 the same day, and the owner's withdrawal of three of them to 28; ledger D54–D76). Builds on
specs/20261112-time-tracking (hours-api, hours-ui) and specs/20261104-meetings (meetings-api); no screen of its own. Design:
`design.md` (the mark's placement, tone and copy win over this plan's § hours-ui sketch; its second pass, after the security
review, is folded in below).

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

> **Amended 2026-11-24 for the security-review additions (approved by the owner 2026-11-24).** The owner added two hardenings to the spec
> (spec AC-2.3 changed, AC-3.8–AC-3.10 added; ledger D63, D67–D70; `owasp-report.md` L1, I8) and the designer's second pass
> (design.md, G7) depends on one of them. What this amendment adds or changes:
> 1. **The measured duration** (AC-3.8–AC-3.10, D63, D68, D69): new § The measured duration; `prepare_audio`'s one commit takes
>    the measured duration when it differs from the held one by more than the larger of 30 s and 10 % (a pure rule), while the
>    meeting is still `processing` (design G7); the existing before/after compare announces it, so untouched entries follow
>    with no change in hours-api. New D-P6 and D-P10 (D-P10 awaits the owner's answer).
> 2. **The mark follows what the entry is on now** (AC-2.3 changed, D67, D70, A47; design S1): one predicate
>    `origin === 'meeting' && on.type === 'meeting'` in hours-ui; the delete sentence keeps `origin` alone. D-P5 rewritten;
>    § Security's G6 note superseded.
>
> Withdrawn by the owner the same day and accepted as risk (ledger D74–D76): review I1 (refused service credentials recorded,
> D74), I3 (identifiers on the wire, D75) and I6 (a deleted meeting keeps no blocks, D76). Nothing of them is built; § Security
> names what stays.
>
> Also changed: § Components, § Where meetings-api records a notice (the `prepare_audio` row), § Deploy order (steps 2 and 3,
> the feature changeset's text), § Data model (no migration), § API contracts, § Test strategy (rows AC-2.3, AC-2.7 and AC-3.2
> changed, three rows added, the mapping total stated), § Risks R9–R11, § Security, § ADR candidates 3–4.

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
measured duration), which reaches hours-api as any other change of a fact.

### Components

| Component | Change |
|---|---|
| **meetings-api** | `Meeting.hoursSeq`; table `hours_notice`; `JobKind` gains `deliver_hours_notice`; `src/hours/notices.ts` (`recordHoursNotice`, called from seven write paths, below); `src/hours/client.ts` (`sendHoursNotice`); `src/jobs/handlers/deliverHoursNotice.ts`; env `HOURS_API_URL`; a migration that also enqueues the release backfill. **Amendment:** `src/media/measuredDuration.ts` (pure `durationAfterMeasure`, AC-3.8, AC-3.10); `src/jobs/handlers/prepareAudio.ts` step-3 commit (`:254-270`) takes the measured duration through it and logs a correction |
| **hours-api** | three `time_entry` columns + CHECKs + a partial unique index; tables `meeting_hours_meeting`, `meeting_hours_block`, `meeting_hours_release`; `src/auth/systemAuth.middleware.ts` (a byte-identical copy of meetings-api's, added to the `systemAuth` group of `scripts/check-shared-copies.ts`); `src/meetingHours/` (`desired.ts` pure, `apply.ts`, `notices.routes.ts`); the PATCH and DELETE handlers of `src/entries/entries.routes.ts` (`:339-382`, `:384-412`); `TimeEntryView.origin` in `src/entries/view.ts`. **Amendment:** only the PATCH handler's comment "`origin` is never written: the mark stays (AC-2.3)" (`:370-371`) becomes "`origin` is never written (AC-2.7 and A47 read it)"; `apply()`, the DELETE handler and the migration stay as built |
| **hours-ui** | `origin` on `TimeEntryView` (`src/lib/hoursApi.types.ts:42-57`); a "From meeting" `Badge` in `src/components/EntryRow.tsx` (List and table cell dialog) and in `src/components/EntriesTable.tsx` (Everyone's hours); a second paragraph in `src/components/DeleteEntryDialog.tsx` for an automatic entry (AC-2.7); strings in `src/strings/entries.ts` and `src/strings/entry.ts` (en + it) — placement and copy per `design.md`. **Amendment:** the badge's condition moves into one predicate, `showsFromMeetingMark` in `src/lib/fromMeetingMark.ts`, called by `EntryRow.tsx:97` and `EntriesTable.tsx:68` (design S1, component inventory); `DeleteEntryDialog.tsx:89` keeps `origin === 'meeting'` alone (D70); the `origin` doc comment of `hoursApi.types.ts` and the two components' doc comments rewritten (design § What this changes in the built code). No new string |
| **both services** | `src/lib/meetingHoursWire.ts`: the notice body's zod schema and caps, a byte-identical copy in meetings-api and hours-api (new `meetingHoursWire` group in `scripts/check-shared-copies.ts`) |
| **meetings-ui** (amendment) | nothing to build: the Duration line (`DetailsCard.tsx:65-69`) renders the `durationMs` the meeting view returns (`meetings-api/src/meetings/view.ts:221`), so it shows the measured duration once written (A43, design S5) |
| **auth** | scope `meeting-hours-notices.send` in `KNOWN_SERVICE_SCOPES` (`auth/src/system/serviceClients.ts:78`), documented; the prescribed scopes of client `meetings-api` gain it |
| **tools/env-doctor** | meetings-api `HOURS_API_URL` (required in production); the meetings-api `SERVICE_CLIENTS` scope set; hours-api `SERVICE_AUDIENCE` now verifies something (already required) |
| **AGENTS.md, infra/README.md, changesets** | Time tracking glossary (automatic entry), hours-api and meetings-api descriptions, the service-client scope list. **Amendment:** the automatic-entry rows say the mark shows "while it is recorded on a meeting" (not "kept after a change"); meetings-api's write list says "filling, correcting or refusing a duration"; infra/README § Meeting hours release gains the `duration_corrected` log line (R9, D-P10); the feature changeset's text for the mark and the measured duration (§ Deploy order) |

Nothing changes in crm-api, estimai-api, projects-api, activities-api, accounting-api, notify-api or the shell.

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

### The measured duration (amendment: AC-3.8–AC-3.10, D63, D68, D69, A42, A43; design G7, S5; D-P6, ADR candidate 4)

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
the held figure until the next visit (R10).

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

**Not covered (R11):** a meeting processed before this release is never measured again, so the release backfill sends its held
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

### Applying a notice (hours-api)

`POST /system/meeting-hours/v1/notices` is mounted **before** the user `jwtMiddleware` on `*`
(`src/index.ts:66`; the estimai-api lesson, ADR 20261104-estimai-api-first-system-route-estimate-man-days-for-a-service-credential: mounted after, a service JWT meets the user gate
and gets 401). `apply(notice)` runs in one transaction, with no outbound call:

1. `INSERT INTO meeting_hours_meeting ("meetingId", seq) VALUES ($1, 0) ON CONFLICT DO NOTHING`, then
   `SELECT seq … FOR UPDATE` — serializes every apply of one meeting.
2. `notice.seq < stored.seq` → commit, `200 { applied: false }`. Equal is re-applied (the A37 day
   delivery, a repeated delivery): applying is idempotent.
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
7. `UPDATE meeting_hours_meeting SET seq = notice.seq, "appliedAt" = now()`, commit, `200 { applied: true }`.

The partial unique index `(userId, sourceMeetingId)` is the database's guarantee of "never twice"
(AC-4.2); the row lock makes it unreachable in practice.

With `facts: null` (the meeting no longer exists) nobody is desired: step 5 removes the untouched entries (AC-3.4), changed
entries and people's own entries stay (AC-3.6), and the meeting's version row and its blocks are kept as they are, so a late,
older notice is still ignored by step 2 (`src/meetingHours/apply.ts:105-169`, as built). Keeping a deleted meeting's blocks is
review I6, accepted as risk by the owner (ledger D76).

**The person's writes** (the only other writers of these rows):
- PATCH (`src/entries/entries.routes.ts:339-382`): every successful PATCH also sets
  `followsMeeting = false` (A39: any saved change). A refused PATCH writes nothing, so the entry stays
  untouched (AC-2.4). **(amendment)** It never writes `origin` (AC-2.7 and A47 read it).
- DELETE (`:384-412`): one interactive transaction — delete the caller's own entry, returning its
  `sourceMeetingId`; when non-null, insert block `(sourceMeetingId, userId, deleted)` `ON CONFLICT DO
  NOTHING` (AC-2.5). The block commits with the delete, and apply's one-statement read (step 4) sees that transaction
  whole or not at all: whenever that read runs, it sees the entry or the block, never neither. The DELETE takes none of
  apply's locks. Unchanged by the amendment.
- POST is unchanged: an entry a person records on a meeting by hand is `origin: person`.

`since` is `meeting_hours_release.since`, written once by hours-api's migration as the Zurich date of
the day it runs (the release day, AC-1.5) — never configuration, so no environment can set it wrong.

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
held durations are not measured again (R11).

### Deploy order

0. **`HOURS_API_URL` on meetings-api, before the merge**: hours-api's private address and port, never its public
   domain (the service token travels in this call). meetings-api's production `env.ts` lists it in
   `PRODUCTION_REQUIRED_KEYS` and exits 1 at start without it, so a meetings-api of this release cannot start until it
   is set, while the running, older code ignores it. It is a precondition of meetings-api's deploy, not a step after it
   (`infra/README.md` § Meeting hours release, Step 0). For the same reason it is never unset to pause the channel:
   the pause is removing the scope from the `SERVICE_CLIENTS` entry.
1. **auth** with the new scope known; only once it is live, add `meeting-hours-notices.send` to the
   `meetings-api` entry of production `SERVICE_CLIENTS` (an unknown scope stops auth, ADR 20261108-crm-pushes-deal-links-to-estimai).
2. **hours-api** and **meetings-api** in either order: notices sent before hours-api has the route get
   404, which is transient, and are delivered once it exists; `since` is hours-api's own release day. **(amendment)** The
   measured duration needs no order: it is meetings-api's alone, and any hours-api of this release applies a corrected
   duration as any other change of a fact.
3. **hours-ui** any time: a `TimeEntryView` without `origin` (an older hours-api) reads as `person`; the mark's new condition is
   client-only.

**(amendment) Changesets:** no new changeset. The feature changeset (`.changeset/meeting-hours-automatic-entries.md`) is
reworded for the mark ("while it is recorded on a meeting", hours-ui) and the measured duration (meetings-api).

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
  (AC-2.7's sentence would then lie about what the deletion does, D70). → ADR candidate 3 (an amendment of the D-P2 ADR).
- **D-P6 (amendment) The measured duration is decided in `prepare_audio`'s one commit, by one pure integer rule
  (`durationAfterMeasure`), from the held duration read under the meeting's row lock, before the meeting leaves `processing`**
  (AC-3.8–AC-3.10, D63, design G7). Rejected: always taking the measured one (A42: timer noise would resize entries and
  re-announce every recording); never correcting (review L1: a claimed duration stands even when the audio says otherwise);
  failing a meeting whose two figures differ (an honest glitch would lose its meeting); a float percentage (an edge vector would
  depend on rounding); deciding in `transcribe` or after `ready` (an open page keeps the held figure, G7); a second notice path
  (the existing compare already announces a changed duration). → ADR candidate 4 (predicted path there).
- **D-P7 — withdrawn by the owner, 2026-11-24** (review I6, accepted as risk; ledger D76): a deleted meeting keeps its blocks, as built.
- **D-P8 — withdrawn by the owner, 2026-11-24** (review I1, accepted as risk; ledger D74): the shared service-credential guard is unchanged.
- **D-P9 — withdrawn by the owner, 2026-11-24** (review I3, accepted as risk; ledger D75): the wire's ids stay 1..64 characters, no character set.
- **D-P10 (amendment; kept by the owner 2026-11-24) A duration correction is logged for the operators** — `[prepare_audio] duration_corrected` with the meeting
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

**(amendment) No migration** for the additions, in either service: the measured duration writes the existing `durationMs`, and
the mark is decided in the browser.

## API contracts

### hours-api — `POST /system/meeting-hours/v1/notices` (new)

```
Authorization: Bearer <service JWT>
  // createSystemAuthMiddleware({ scope: "meeting-hours-notices.send", allowedSubs: ["system:meetings-api"] })
  // RS256 via AUTH_JWKS_URL, issuer AUTH_ISSUER, aud = SERVICE_AUDIENCE. Every failure — none, a user JWT,
  //   another aud / iss / key / scope / sub (another service client holding the scope included), expired,
  //   malformed, a non-Bearer scheme — is the same 401, byte for byte. Checked BEFORE the body.
  // Attached per route (createRoute({ middleware })), never use("*"); the router is mounted before jwtMiddleware.

Request (strict: an unknown key anywhere is a 400)
{
  noticeId: string,                  // 1..64; logged, not stored
  meeting: {
    id:  string,                     // 1..64
    seq: integer,                    // 1..2147483647
    facts: null                      // the meeting no longer exists
         | {
             startsAt:       string,          // ISO 8601 date-time WITH offset
             durationMs:     integer | null,  // 0..2147483647; null = not known
             creatorId:      string,          // 1..64
             participantIds: string[]         // 0..100 distinct, each 1..64; Operai participants only
           }
  }
}

200 { applied: boolean }   // false: an older version than the one applied (nothing changed)
400 problem+json invalid_request { field }   // a JSON body the wire refuses: a missing or unknown key, a value out
                                             //   of bounds (`field` names the first); malformed or empty JSON is the
                                             //   same 400 without `field` — the sender treats it as permanent
401 problem+json (one body)
413 problem+json           // over the global 64 KiB body cap (src/index.ts, every route), decided BEFORE the guard
415 problem+json           // a body not declared as JSON (Hono, as on every hours-api route), decided after the guard
500                        // database failure — the sender retries
```

Order of the answers: the body cap (413), the guard (401), the media type (415), the wire (400), then `apply()`. The
cap (`bodyLimit`, `src/index.ts:44-51`) is global and runs before the route's guard, parsing nothing: a declared
`Content-Length` over 64 KiB is refused from the header without reading the body, and a body sent without a length
(chunked) is buffered up to the cap and refused once it passes it. Neither answer says anything about the credential.
meetings-api meets neither (it always declares JSON, and the wire's caps keep any notice far below 64 KiB); were one
to occur, the sender would treat it as transient (§ Delivering a notice).

Never in the body: a title, external participants, a host, any content (AC-4.1). No outbound call is
made while applying (AC-2.6: no notification). Logged per apply: `meeting_hours.applied` with
`meetingId`, `seq`, `applied`, and counts created / moved / removed / blocked — never a user id.

### hours-api — changed

- **`TimeEntryView`** gains `origin: "person" | "meeting"` (required). `src/openapi.contract.test.ts:159`
  and `:164` (the pinned key lists) and `view.test.ts` are updated. `followsMeeting` and `sourceMeetingId`
  are never returned: they decide what Operai does, not what the person sees. **(amendment)** `origin` stays `meeting` after
  any change, a move off the meeting included: the delete sentence (AC-2.7, D70) and A47 read it.
- **`PATCH /time-entries/{id}`**: request, rules and errors unchanged; a 200 now also means the entry no
  longer follows its meeting.
- **`DELETE /time-entries/{id}`**: request and errors unchanged; deleting an automatic entry also blocks
  it from coming back (AC-2.5).
- List, totals and export: unchanged contracts; automatic entries are rows like any other.

### meetings-api — outbound (new)

`sendHoursNotice(notice, tokens)` → the request above. Outcome mapping in § Delivering a notice. Env:
`HOURS_API_URL` (`src/lib/env.ts`): URL, required when `NODE_ENV=production`, default
`http://localhost:8090` otherwise; listed in env-doctor's manifest for meetings-api.

### Operator log line (amendment; a contract for infra/README and the tests)

| Service | Line | When | Carries | Never |
|---|---|---|---|---|
| meetings-api | `console.log("[prepare_audio] duration_corrected", { meetingId, heldMs, measuredMs })` | after a `prepare_audio` commit that replaced a held duration (not one that filled a null) | meeting id, two integers | user id, title, content |

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
`meetings-capture.spec.ts`). **(amendment)** **C-M** meetings-ui component (Vitest).

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
| AC-2.5 | I-H | DELETE of an automatic entry (touched or not) writes block `deleted`; newer notices — same facts, participant removed and re-added — never recreate it; a DELETE racing an apply of the same meeting (two connections, repeated rounds, `src/meetingHours/apply.test.ts`, existing and unchanged) ends with the block and no entry |
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

**The mapping is total: 28 of 28** acceptance criteria (AC-1.1–1.8, AC-2.1–2.7, AC-3.1–3.10, AC-4.1–4.3), each with a test
named above that proves it; none is unmappable.

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
- **R10 (amendment) A later change moves the correction after the meeting leaves `processing`** → an open Meetings page keeps
  the held figure (design G7). Early check: the AC-3.8 I-M test asserts `status = processing` with the corrected duration after
  `prepare_audio` alone.
- **R11 (amendment) Meetings processed before the release keep their held duration**, so the backfill's entries rest on a duration
  never measured. Accepted: 14 days, creator-trusted before, each person can change or delete; no reprocessing.

## Security

**Security-sensitive: YES** — schedules an owasp-reviewer pass in parallel with QE. **(amendment)** An **owasp delta pass** over
the two additions is scheduled in parallel with QE, and covers only: `prepare_audio`'s correction (the step-3 commit of
`meetings-api/src/jobs/handlers/prepareAudio.ts` and `src/media/measuredDuration.ts`: a write of the fact every participant's
entry is built from) and hours-ui's predicate (`src/lib/fromMeetingMark.ts` and its callers `EntryRow.tsx` and
`EntriesTable.tsx`: what a `time-entry:read-all` holder learns from the mark).

- **New authentication path in hours-api**: its first route that accepts a service JWT. Verified exactly
  as meetings-api's system routes (shared middleware copy): RS256, issuer, `aud = SERVICE_AUDIENCE` (≠
  `AUTH_AUDIENCE`), scope `meeting-hours-notices.send`, `sub` allowlist `system:meetings-api`, one 401 for
  every failure, checked before the body. The matrix test fails on any unpinned `/system/` route.
- **(amendment) Review notes I1, I3 and I6: accepted as risk by the owner (ledger D74–D76); nothing of them is built.** What
  stays as it is: a service credential that verifies but is refused for its `sub` or its scope gets the one 401 with no log
  line, in every copy of the shared guard (I1, D74); a wire id has a length (1..64) and no character set, so a NUL reaches Postgres
  as a 500 that the sender retries (30 s, 2 min, 10 min, then every 30 minutes) for that one meeting — unreachable from the
  legitimate sender, whose ids are cuids, uuids and auth ids (I3, D75); and a deleted meeting's `meeting_hours_block` rows (meeting
  id, user id, reason) stay with its version row, with no erasure path, as `time_entry` rows do (I6, D76).
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
- **Personal data in transit**: attendance (who, when, how long) crosses services — the minimum the
  feature needs; no title or content (AC-4.1). The outbox stores no personal data (ids built at send);
  hours-api stores only what an entry already holds plus `meeting_hours_block` (meeting id, user id,
  reason). Logs carry no user id. **(amendment)** The duration correction log carries a meeting id and two figures, no person
  (D-P10).
- **(amendment) The mark in Everyone's hours (design G6, review I8): superseded by D67.** The mark now shows only while an entry
  is on a meeting, so a `time-entry:read-all` holder no longer learns from it that a person attended a meeting whose hours they
  recorded elsewhere. What a holder can still read is what they always could: the entries on a meeting, and that such an entry
  was recorded by Operai. `origin` still reaches the client for a moved entry (the delete sentence, D70). On screen it is
  rendered to its person only, in their own delete confirmation; on the wire it is in the view every reader receives
  (`hours-api/src/entries/view.ts`), so a `time-entry:read-all` holder reading the JSON learns that a moved entry began as an
  automatic meeting entry. I8 had already judged that bit acceptable on screen, so this is accepted as no new exposure (owasp
  delta review N3); masking `origin` in a non-owner view was not taken.
- **Labour-law go-live sign-off (spec O3, accepted as risk)** — automatic recording of hours about a
  person: management / HR before go-live.
- No new external host, no data-residency change, and (amendment) no new reader of bytes: the measured duration is the one
  ffprobe already returned.

## ADR candidates

1 and 2 were written 2026-11-24 (paths in § Decisions this plan makes) and indexed in AGENTS.md. 3 and 4 come from the amendment
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
3. **(amendment of ADR 20261124-a-system-written-time-entry-follows-its-source-fact-only-…)** Two points of its Consequences
   change: (a) the "From meeting" mark follows the entry's current target (`origin === 'meeting' && on.type === 'meeting'`),
   while `origin` itself is still never recomputed because the delete sentence and A47 read it (D-P5, D67, D70) — rejected:
   the mark on `origin` alone (D57/D62, review I8), recomputing `origin` on a move; (b) its risk "a forged duration is capped by
   the stored recording chunks and the 24 h entry cap" is wrong (review L1) and is replaced by § Security's duration bullet with
   D63. Path: the existing file, an `## Amendment 2026-11-24` section; referenced from D-P5.
4. **(new ADR, the lighter of the two; may instead be an `## Amendment 2026-11-24` section of ADR
   20261124-meeting-hours-facts-pushed-by-their-owner-…, the ADR about the facts meetings-api owns, if the owner prefers) A figure
   a client reports and the server can measure is replaced by the measurement when they differ by more than noise — the larger
   of 30 s and 10 % — decided once, in the transaction that has the measurement, before the record leaves the state its readers
   watch** (D-P6, D63, design G7). Rejected: always replacing (noise resizes entries), never replacing (review L1), refusing the
   record on a mismatch (an honest glitch loses it), deciding after the watched state ends (stale open pages). Predicted path:
   `docs/adr/20261124-a-duration-a-client-reports-is-replaced-by-the-one-the-server-measures-when-they-differ-by-more-than-the-larger-of-30-seconds-and-10-percent.md`;
   referenced from D-P6 and § The measured duration.

## Amendment 2026-11-25 — review cleanup (approved by the owner 2026-11-25)

Corrected 2026-11-25 after implementation: S2's order mutation, S5's failure mode, S6's check (no scope change).

> Drafted by the architect on 2026-11-25 for the owner's gate. It is a behaviour-preserving cleanup of the seven review items the
> owner picked for PR #12 (branch `feat/meeting-hours`, checked at HEAD `3bf7c402`, base `origin/main` `a17c260f`). No
> acceptance criterion, contract, migration, log line or copy changes. No earlier section of this plan changes: item 7 had
> already been applied (below). `/wellforge:tasks` derives one task from each step S1 to S7.

### Verdicts

| # | Item | What the code shows | Verdict | Step |
|---|---|---|---|---|
| 1 | Double row lock | Confirmed. The duplicate is wider than reported: `readHoursFacts` also runs inside `recordHoursNotice` after the write. | Do it: one lock primitive. The statements sent to Postgres stay the same. | S1 |
| 2 | Participant ids read twice | Confirmed. The two reads also order the ids differently: `record.ts` sorts in JavaScript, `delivery.ts` lets the database sort. | Do it: one reader, in the database's order. The two fact types stay separate. | S2 |
| 3 | `FromMeetingBadge` | Confirmed. | Do it. | S3 |
| 4 | P2025 check and day helper | Confirmed. The P2025 check appears twice (the PATCH one predates this feature). The day conversion appears five times, all identical. | Do it for those seven sites. `spanDays` is left as it is. | S4 |
| 5 | Block write lives in the routes | Confirmed. | Do it. | S5 |
| 6 | Traceability comments | `AC-4.10` is specs/20261104-meetings' log rule, cited without its spec, so it reads as this spec's, which has none. `AC-1.6` is correct. | Qualify `AC-4.10`. No change for `AC-1.6`. | S6 |
| 7 | § Security sentence (owasp N3) | Already rewritten by `efc69b48` (§ Security, the bullet "The mark in Everyone's hours", lines 745–749). | Nothing to edit. | — |

### Current state (checked at `3bf7c402`)

**1. The lock.**
- `readHoursFacts` (`meetings-api/src/hours/record.ts:62-70`) opens with `SELECT "id" FROM "meeting" WHERE "id" = ${meetingId} FOR UPDATE` (`:63`).
- `lockMeeting` (`meetings-api/src/meetings/lock.ts:12-15`) runs the same statement (`:13`).
- They behave differently when the row is missing: `lockMeeting` throws the identical 404 (`meetingNotFound()`), and `readHoursFacts` returns `null`.

Callers of `readHoursFacts`:
- **Before the write:** `capture/recording.routes.ts:385` (`beginProcessing`), `capture/upload.routes.ts:184`, `jobs/handlers/prepareAudio.ts:194` (refused upload) and `:268` (step-3 commit), `meetings/core.routes.ts:194`, `meetings/participants.routes.ts:94`.
- **After the write:** inside `recordHoursNotice` (`record.ts:110`). Each path above reaches it at `recording.routes.ts:398`, `upload.routes.ts:198`, `prepareAudio.ts:201`, `:283`, `core.routes.ts:255` or `participants.routes.ts:123`.
- **Not a caller:** `delete.routes.ts`. It takes `lockMeeting` (`:108`), then calls `recordHoursNotice(…, { deleted: true })` (`:121`), which reads no facts.

So while the channel is on, every state path sends the lock statement twice. `core.routes.ts` and `participants.routes.ts` call `lockMeeting` first (`:190`, `:92`), so they send it three times. Re-locking a row the transaction already holds never waits and never deadlocks: the cost is one round trip, and correctness is not affected.

The real fault is the duplicated SQL together with its two missing-row behaviours. A future edit that swaps one for the other would not be noticed:
- `prepareAudio.ts:281` and `:287-291` rely on `null` for a meeting deleted while ffmpeg ran.
- No test covers that path.
- No test pins that `readHoursFacts` holds the lock, which owasp-report.md Q5 relies on.

**2. The participant ids.**
- `readHoursFacts` reads them at `record.ts:67-68`: `findMany({ where: { meetingId, userId: { not: null } }, select: { userId: true } })`, then a Set, then the JavaScript `.sort()`.
- `bodyFor` reads them at `meetings-api/src/hours/delivery.ts:79-84`: the same `where` and `select` plus `orderBy: { userId: "asc" }`, then a Set, with no JavaScript sort.
- The two orders differ whenever ids differ in case. The test databases use `en_US.utf8`: `amy` < `Bob` there, while a JavaScript sort puts `Bob` < `amy`.
- The database order is the wire's order (decisions T8). Through hours-api's `desiredEntries` (T4: creator, then participants in wire order) it is also the order in which `apply()` creates automatic entries.
- The Set is defensive: `@@unique([meetingId, userId])` is at `prisma/schema.prisma:266`.
- `HoursFacts` (`record.ts:47-52`) and `MeetingHoursFacts` (`src/lib/meetingHoursWire.ts:52`) differ in purpose and shape:
  - `HoursFacts`: `startsAt` is a `Date`, and there is no `creatorId` because the creator is never compared.
  - `MeetingHoursFacts`: `startsAt` is an ISO string, and `creatorId` is present.

**3. The badge.**
- The same `` <Badge tone="accent" data-testid={`hours-entry-${entry.id}-from-meeting`}>{strings.entries.fromMeeting}</Badge> `` appears at `hours-ui/src/components/EntryRow.tsx:105-107` and `hours-ui/src/components/EntriesTable.tsx:88-90`.
- In `EntriesTable.tsx`, that is the only use of the `Badge` import (`:1`).
- The tests cover copy, test id and placement: `EntryRow*.test.tsx`, `EntriesTable*.test.tsx`, `TableView.fromMeeting.test.tsx`. No test asserts the tone (`badge-accent`).

**4. The helpers.**
- P2025: `(error as { code?: unknown } | null)?.code === "P2025"` appears at `hours-api/src/entries/entries.routes.ts:378` (PATCH, from specs/20261112-time-tracking) and `:392` (DELETE, this feature).
- Day to `Date`: `` new Date(`${day}T00:00:00Z`) `` appears at `entries.routes.ts:326` (POST) and `:361` (PATCH), at `filters.ts:94` (`dayOf`, used twice at `:147`), at `list.routes.ts:91` (a local *variable* named `dayDate`, used three times at `:93`), and at `meetingHours/apply.ts:76-77` (a local `dayDate`, used at `:132` and `:147`).
- Every input is a validated calendar day: `DaySchema`, `isCalendarDay`, or the Zurich day from `desiredEntries`.
- `filters.ts:71` `spanDays` is not the same conversion: it uses `Date.parse` and returns a count of milliseconds.

**5. The block.**
- The DELETE handler (`entries.routes.ts:384-412`) runs one interactive transaction:
  - `tx.timeEntry.delete(… select: { sourceMeetingId: true })` (`:390`), with P2025 mapped to `null`;
  - a comment explaining the rule and the read order (`:396-402`);
  - the block insert (`:403-405`): `if (gone.sourceMeetingId !== null) await tx.meetingHoursBlock.createMany({ data: [{ meetingId: gone.sourceMeetingId, userId, reason: "deleted" }], skipDuplicates: true })`.
- What the tests pin: `automatic.test.ts:159-270` (the block, a moved entry, no block for a typed entry, 404/403, an existing block kept, one transaction) and `meetingHours/apply.test.ts:618` (the DELETE-against-apply race).
- No test pins that a failed block insert takes the delete back with it.

**6. The citations.**
- `meetings-api/src/hours/delivery.ts:30` ("Never a user id, a title, a token or a body (AC-4.10)") and `client.ts:25-26` ("(AC-4.1, AC-4.10)") cite AC-4.10 of specs/20261104-meetings (spec.md:473, "logs and error reports hold identifiers and sizes only"). meetings-api cites its own spec bare elsewhere (`hosts/client.ts:26`, `jobs/runner.ts:38`).
- In these two files the header names specs/20261112-meeting-hours, whose ACs end at AC-4.3. So the bare `AC-4.10` reads as a dangling reference.
- The stricter "no user id" rule is this feature's own: plan § Security ("Logs carry no user id") and § API contracts.
- `AC-1.6` at `hours-api/src/meetingHours/notices.routes.ts:3` and `tools/env-doctor/manifest.ts:266` (also `:385`) is deliberate and consistent with the rest of the feature:
  - plan § Test strategy maps AC-1.6 to the route guard ("only `system:meetings-api` with the scope reaches the route; activities-api and crm-api are unchanged");
  - tasks T1 and T7 list AC-1.6 in their refs;
  - `auth/src/system/serviceClients*.test.ts` cites it the same way.
- The guard is the reason a CRM call or meeting activity can never record an automatic entry. Changing the citation would make the code disagree with the plan and the tasks.

**7.** owasp N3's sentence ("shown to its person only") is no longer in § Security: `efc69b48` replaced it, and the bullet now reads: "On screen it is rendered to its person only, in their own delete confirmation; on the wire it is in the view every reader receives (`hours-api/src/entries/view.ts`)…" (lines 745–749, commit `efc69b48`, which also synced tasks.md). That matches the build and the owner's decision of 2026-11-25 to keep the wire as it is (ledger D77, which also rewords spec.md's non-goal "A history of where a moved entry came from").

### Target state

**S1: one lock primitive** (`meetings-api/src/meetings/lock.ts`):

```ts
/** Takes one meeting's row lock until the transaction ends; `false` when there is no such row (it never throws for one). */
export async function lockMeetingRow(tx: Prisma.TransactionClient, id: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "meeting" WHERE "id" = ${id} FOR UPDATE`;
  return rows.length > 0;
}

/** Locks the row, or throws the identical 404 when it is gone (deleted since the caller opened it). */
export async function lockMeeting(tx: Prisma.TransactionClient, id: string): Promise<void> {
  if (!(await lockMeetingRow(tx, id))) throw meetingNotFound();
}
```

- `readHoursFacts` begins with `if (!(await lockMeetingRow(tx, meetingId))) return null;` (`null`, never the 404). Its doc comment says that it locks and why, and the rest of the function is unchanged.
- The SQL statements, their order and their count are exactly today's on every path.
- Import graph: `lock.ts` → `./visibility` → `lib/db`, `lib/problem`, `lib/identities`, `hosts/client`, `hosts/registry`. None of them imports `src/hours/`, so there is no cycle.

Rejected:
- (a) `readHoursFacts` takes no lock and trusts its caller. Recording stop, upload confirm and both `prepare_audio` commits would each need their own lock, and "the snapshot is never stale" would depend on every future caller remembering it.
- (b) Drop `lockMeeting` from core and participants, and answer 404 when `readHoursFacts` returns `null`. That hands the routes' own lock to the hours module (it guards `core.routes.ts:191`'s row read and the participant diff) and reorders their statements.
- (c) `readHoursFacts` calls `lockMeeting` and catches the 404. That is an exception used for control flow, which is exactly the swap this step guards against.

The runtime repeats stay. They are a no-op on a row the transaction already holds.

**S2: one participant reader.** New file `meetings-api/src/hours/participants.ts`:

```ts
/**
 * The distinct user ids of a meeting's Operai participants (an external participant has none), in the order the database sorts
 * `userId`: the order of the notice body (decisions T8) and, through hours-api's `desiredEntries`, the order automatic entries are
 * created in. Never re-sorted in JavaScript (a code-unit sort differs from the database's for mixed case). Reads only, no lock:
 * `readHoursFacts` has locked the meeting before it, the delivery reads in its own repeatable-read snapshot.
 */
export async function operaiParticipantIds(tx: Prisma.TransactionClient, meetingId: string): Promise<string[]> {
  const people = await tx.meetingParticipant.findMany({
    where: { meetingId, userId: { not: null } },
    select: { userId: true },
    orderBy: { userId: "asc" },
  });
  return [...new Set(people.flatMap((p) => (p.userId !== null ? [p.userId] : [])))];
}
```

- `bodyFor` (`delivery.ts:79-84`) becomes `return { meeting, participantIds: await operaiParticipantIds(tx, row.meetingId) };`. That is the same query as today, so the body stays byte-identical.
- `readHoursFacts` uses the new reader and drops its JavaScript `.sort()` (`record.ts:68`). The `HoursFacts` doc changes from "sorted and distinct" to "distinct, in the database's order of user id". It also points to `MeetingHoursFacts` as the wire form of the same facts.
- `sameFacts` is unchanged. Its answer is the same for every pair of snapshots:
  - before and after are both read in one transaction, through one `ORDER BY` on one deterministic collation (ties are broken bytewise), so one set of ids always comes back in one order;
  - a positional compare of two lists, each sorted by the same total order, is a set compare.
- The array order inside `HoursFacts` is the only thing that differs from today. It is not logged, stored or sent.

Rejected:
- Keeping a JavaScript sort in the shared reader. It would change the wire order, and with it the creation order of entries, for any ids the two orders disagree on.
- Keeping the sort in `record.ts` only. That leaves two orders for one fact, which is the drift this item is about.
- Deriving `HoursFacts` from `MeetingHoursFacts`. It would tie the lock-time compare to the shared wire file (R2), and the two differ in `startsAt` type and in `creatorId`.

`meetingHoursWire.ts` is not touched in either copy.

**S3: one badge.** New file `hours-ui/src/components/FromMeetingBadge.tsx`:

```tsx
import { Badge } from '@operai/ui'
import { strings } from '../strings'

/**
 * The "From meeting" mark of one entry (specs/20261112-meeting-hours AC-2.3, AC-4.3; design S1, S2): its tone, copy and test id
 * in one place for `EntryRow` and `EntriesTable`. It draws unconditionally: whether to draw it is `showsFromMeetingMark`
 * (src/lib/fromMeetingMark.ts), and where is each caller's layout. hours-specific, so not in @operai/ui.
 */
export default function FromMeetingBadge({ entryId }: { entryId: string }) {
  return (
    <Badge tone="accent" data-testid={`hours-entry-${entryId}-from-meeting`}>
      {strings.entries.fromMeeting}
    </Badge>
  )
}
```

- `EntryRow.tsx:105-107` and `EntriesTable.tsx:88-90` become `<FromMeetingBadge entryId={entry.id} />`. `Badge` leaves `EntriesTable.tsx`'s import (`:1`).
- The predicate calls (`EntryRow.tsx:100`, `EntriesTable.tsx:71`), the wrappers and `min-w-0` stay where they are. The DOM is identical.

Rejected:
- The predicate inside the component, returning `null` otherwise. Both callers need the predicate's answer for their own wrappers, so it would be asked twice.
- An `entry` prop. Only the id is used.

**S4: two helpers.**

In `hours-api/src/entries/rules.ts`, § A day, beside `isCalendarDay` (pure, which fits the module's rule). Not `today.ts`, which is the clock, and not a new module for one line:

```ts
/** A `YYYY-MM-DD` day as the UTC midnight the `date` column stores and compares (every entry write and every day filter). */
export const dayDate = (day: string): Date => new Date(`${day}T00:00:00Z`);
```

It is used at:
- `entries.routes.ts:326` and `:361`;
- `filters.ts:147`, where `dayOf` (`:94`) is removed and `dayDate` is imported from `./rules`;
- `list.routes.ts:91-93`, where the local variable is renamed (`const dayAt = dayDate(day);`, then `dayAt` three times);
- `meetingHours/apply.ts:132` and `:147`, where the local `:76-77` is removed and `dayDate` is imported from `../entries/rules`, as `desired.ts` already does.

In `entries.routes.ts`, module-local, because both uses are in this file:

```ts
/** Prisma's P2025: the row the statement addressed is not there (deleted meanwhile, or never the caller's). */
const isRecordNotFound = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === "P2025";
```

- `:378` becomes `throw isRecordNotFound(error) ? entryNotFound() : error;`.
- `:392` becomes `if (isRecordNotFound(error)) return null;`.
- The expression is unchanged, so the result is identical for every input.

**S5: the rule under `meetingHours/`.** New file `hours-api/src/meetingHours/blocks.ts`:

```ts
/**
 * AC-2.5: an automatic entry its person deletes is never recorded again for them on its meeting. Called by the DELETE route
 * (src/entries/entries.routes.ts) INSIDE ITS OWN TRANSACTION, right after the delete statement, with what that statement returned:
 * the block commits with the delete, so the committed state holds the entry or the block, never neither, and apply()'s
 * one-statement read (`readState`) sees one of them. It takes no lock and reads nothing (a lock here would invert apply()'s
 * order, decisions T5). Nothing for an entry its person typed (`sourceMeetingId` null, CHECK time_entry_origin_shape); a block
 * already there is kept with its reason (`ON CONFLICT DO NOTHING`).
 */
export async function blockDeletedEntry(
  tx: Prisma.TransactionClient,
  deleted: { readonly userId: string; readonly sourceMeetingId: string | null },
): Promise<void> {
  if (deleted.sourceMeetingId === null) return;
  await tx.meetingHoursBlock.createMany({
    data: [{ meetingId: deleted.sourceMeetingId, userId: deleted.userId, reason: "deleted" }],
    skipDuplicates: true,
  });
}
```

- `entries.routes.ts:403-405` becomes `await blockDeletedEntry(tx, { userId, sourceMeetingId: gone.sourceMeetingId });`.
- The parameter is an object so that the two ids, both strings, cannot be swapped without the compiler noticing.
- What stays in the route:
  - the delete statement and its P2025 → `null`;
  - the 404 / 403 `owner_only` answer;
  - the read-order sentence of its comment ("This handler takes no lock of apply()'s: apply() reads … in ONE statement, `readState` …"), which T7's done-when placed there.
- The rest of the comment moves to `blocks.ts`.
- The DELETE transaction still runs exactly: the delete with `RETURNING "sourceMeetingId"`, then, only when that is non-null, `INSERT … ON CONFLICT DO NOTHING`.

Rejected:
- Moving the delete statement too (a `deleteOwnEntry`). It carries the route's 404 decision.
- Putting the function in `apply.ts`. That file is the notice's transaction, and the DELETE is the person's.
- Folding in apply's own `had_entry` insert (`apply.ts:141`). It is not this item, and its count feeds the `meeting_hours.applied` log line (listed below as observed, not planned).

**S6: qualified citations** (comment-only edits):
- `delivery.ts:30` becomes "… Never a user id, a title, a token or a body (specs/20261104-meetings AC-4.10; no user id: this plan § Security)."
- `client.ts:25-26` becomes "… never a user id, a token or a body (AC-4.1; specs/20261104-meetings AC-4.10; no user id: this plan § Security)."
- `AC-1.6` is not edited.

### Invariants (must hold after every step)

- **I1 No wire or OpenAPI change.**
  - `meetingHoursWire.ts` is untouched in both copies.
  - The body meetings-api sends is byte-identical for the same meeting, including the order of `participantIds`.
  - `TimeEntryView`, the routes and the OpenAPI document are unchanged.
- **I2 No migration added or edited.** `git diff 3bf7c402 -- meetings-api/prisma hours-api/prisma` is empty.
- **I3 No shared-copy group changed.**
  - `scripts/check-shared-copies.ts` is untouched.
  - No touched file is in a group. The groups' files in these apps are `systemAuth.middleware.ts`, `logger.ts`, `meetingHoursWire.ts`, `problem.ts`, `serviceToken.ts` and `s3Residency.ts`.
  - `mise run shared:check` is green.
- **I4 No log line changed.** `git diff 3bf7c402 -U0 -- '*.ts' '*.tsx' | grep -E '^[-+][^-+].*console\.'` is empty.
- **I5 No user-visible copy or DOM changed.**
  - `hours-ui/src/strings/**` is untouched.
  - The badge renders the same element, class, test id and text.
- **I6 Same statements in the same transactions.**
  - Every meetings-api write path sends the same SQL, in the same order and count (S1, and S2's reads).
  - The DELETE runs delete, then a conditional `INSERT … ON CONFLICT DO NOTHING` in one transaction, with no lock and no read added (S5).
- **I7 Same answers at the edges.**
  - `readHoursFacts` of a missing meeting is `null` and never throws.
  - `lockMeeting` of a missing meeting throws the identical 404.
  - `sameFacts` answers the same for every pair of snapshots.
  - PATCH and DELETE keep mapping P2025 to 404 / "nothing deleted" and rethrow anything else.
- **I8 Tests only grow.**
  - Every existing test is green and none is weakened.
  - `git diff 3bf7c402 --numstat -- '*.test.ts' '*.test.tsx'` shows 0 deleted lines. No moved symbol is imported by a test, so no existing test line needs to follow one.
- **I9 No new environment variable, scope, dependency or public export.** hours-ui's `exposes` and the `RecordHours.graph.test.ts` walk are unchanged.

### Steps

Each step lists `touch:` (every file it creates or modifies), `done when:` (runnable) and `deps:`. Every new test is written first and is green on `3bf7c402`: it characterises today's behaviour. It is then shown red under the mutation named next to it (applied by hand and reverted) before the refactor is made.

**Scheduling:**
- meetings-api: S1 and S6 can run in parallel (no shared file). S2 comes after both: it shares `record.ts` with S1 and `delivery.ts` with S6.
- hours-api: S4, then S5 (both touch `entries.routes.ts`).
- hours-ui: S3 can run at any time.
- Across apps: the meetings-api chain, the hours-api chain and S3 are parallel to each other.
- S7 comes last.

- **S1 [BE] meetings-api: one lock primitive.** Refs: AC-3.1–AC-3.4, AC-3.8 (the snapshot every notice and the measured duration are decided from). Deps: none. Parallel with S3, S4, S5, S6.
  - touch: `meetings-api/src/meetings/lock.ts`, `meetings-api/src/hours/record.ts`, `meetings-api/src/hours/record.test.ts`.
  - new tests in `record.test.ts`:
    - (a) "readHoursFacts holds the meeting's row lock until its transaction ends". Inside `db.$transaction`, after `readHoursFacts(tx, m.id)`, a query on another connection, `SELECT "id" FROM "meeting" WHERE "id" = ${m.id} FOR UPDATE SKIP LOCKED`, returns no row. After the commit it returns one. Mutation: remove the lock.
    - (b) "readHoursFacts of a meeting that is not there is null, not a 404". Mutation: call `lockMeeting` instead.
  - done when:
    - `lockMeetingRow` and `lockMeeting` are as in § Target state S1, and `readHoursFacts` calls `lockMeetingRow`.
    - `grep -n 'SELECT "id" FROM "meeting"' meetings-api/src/hours/record.ts` prints nothing. (Grep the statement, not `FOR UPDATE`: the doc comment at `record.ts:59` names it.)
    - `grep -c 'SELECT "id" FROM "meeting"' meetings-api/src/meetings/lock.ts` prints `1`.
    - (a) and (b) pass.
    - `cd meetings-api && bun run typecheck && DATABASE_URL=postgresql://postgres:postgres@localhost:5435/meetings_test bun test` is green.
- **S2 [BE] meetings-api: one participant reader.** Refs: AC-1.1, AC-1.2, AC-3.3, AC-4.1. Deps: S1, S6.
  - touch: `meetings-api/src/hours/participants.ts` (new), `meetings-api/src/hours/participants.test.ts` (new), `meetings-api/src/hours/record.ts`, `meetings-api/src/hours/delivery.ts`, `meetings-api/src/jobs/handlers/deliverHoursNotice.test.ts`.
  - new tests:
    - in `deliverHoursNotice.test.ts`, under "the body is built at send time": "lists the Operai participants in the database's order of user id, never re-sorted (decisions T8)".
      - Participants `zed-1`, `Bob-2`, `amy-3`.
      - The delivered `participantIds` must equal `SELECT "userId" FROM meeting_participant WHERE "meetingId" = … AND "userId" IS NOT NULL ORDER BY "userId"`, run by the test.
      - The test also asserts that this order differs from `[...ids].sort()`, so it would fail on a database whose collation agrees with JavaScript instead of passing for nothing.
      - Mutation: add `.sort()` to the reader. This test cannot see a dropped `orderBy`. Postgres serves the reader's `findMany` (`where: { meetingId, userId: { not: null } }`) with an index scan on the unique index `meeting_participant_meetingId_userId_key`, so the rows come back in the database's collation order with or without an `ORDER BY`.
    - `meetings-api/src/hours/participants.test.ts`, a direct test of `operaiParticipantIds`. It imports the new export, so unlike the delivery test it cannot run on `3bf7c402`. It has two cases:
      - "lists the Operai participants' user ids in the database's order, never an external participant, never re-sorted". The same three participants plus an external one, with the same self-guard against a collation that agrees with JavaScript.
      - "gets that order from the database's ORDER BY, not from the plan: with every index scan off the order is still the database's". `SET LOCAL` turns off `enable_indexscan`, `enable_indexonlyscan` and `enable_bitmapscan`, so Postgres reads the heap in insertion order (`zed-1` first). The test asserts that a `findMany` without `orderBy` comes back in another order than the database's, then that the reader's does not. Mutation: drop the reader's `orderBy`.
  - done when:
    - `grep -rn 'userId: { not: null }' meetings-api/src/hours --include='*.ts' | grep -v '\.test\.ts'` prints `participants.ts` only.
    - `grep -n '\.sort()' meetings-api/src/hours/record.ts meetings-api/src/hours/participants.ts` prints nothing.
    - `meetingHoursWire.ts` is untouched in both copies (`git diff 3bf7c402 --stat -- '*/src/lib/meetingHoursWire.ts'` is empty).
    - The new tests pass, and `record.test.ts:84-139` (the compare rules, "the same people in another order … is no change" included), `triggers.test.ts` and `deliverHoursNotice.test.ts` pass unchanged.
    - The meetings-api command of S1 is green.
- **S3 [FE] hours-ui: `FromMeetingBadge`.** Refs: AC-2.3, AC-4.3. Deps: none. Parallel with everything else.
  - touch: `hours-ui/src/components/FromMeetingBadge.tsx` (new), `hours-ui/src/components/FromMeetingBadge.test.tsx` (new), `hours-ui/src/components/EntryRow.tsx`, `hours-ui/src/components/EntriesTable.tsx`.
  - new test `FromMeetingBadge.test.tsx` (jsdom): `<FromMeetingBadge entryId="e1" />` renders `hours-entry-e1-from-meeting` with the text "From meeting" and a class list containing `badge-accent`, the one property no existing test pins. Mutation: another `tone`.
  - done when:
    - `grep -rn 'from-meeting' --include='*.tsx' hours-ui/src | grep -v '\.test\.tsx'` prints `FromMeetingBadge.tsx` only. (Grep the test id, not `tone="accent"`: `TableView.tsx:86, :105` use that tone for "Today".)
    - `grep -n 'Badge' hours-ui/src/components/EntriesTable.tsx` prints only `FromMeetingBadge` lines.
    - `EntryRow.test.tsx`, `EntryRow.it.test.tsx`, `EntriesTable.test.tsx`, `EntriesTable.it.test.tsx` and `TableView.fromMeeting.test.tsx` pass unchanged.
    - `cd hours-ui && pnpm lint && pnpm exec tsc -b && pnpm test` is green (`noHardcodedStrings` and `catalogGaps` included).
- **S4 [BE] hours-api: `dayDate` and `isRecordNotFound`.** Refs: AC-1.1 (the entry's day), time-tracking AC-1.3. Deps: none. Parallel with S1, S2, S3, S6.
  - touch: `hours-api/src/entries/rules.ts`, `hours-api/src/entries/rules.test.ts`, `hours-api/src/entries/filters.ts`, `hours-api/src/entries/list.routes.ts`, `hours-api/src/entries/entries.routes.ts`, `hours-api/src/meetingHours/apply.ts`.
  - new test in `rules.test.ts`: `dayDate("2026-03-29").getTime() === Date.UTC(2026, 2, 29)` (a European daylight-saving day). It is a direct test of the new export. It catches a missing `Z` only when the test process's zone is not UTC. The end-to-end proof is the existing day tests below.
  - done when:
    - `grep -rn 'T00:00:00Z' hours-api/src --include='*.ts' | grep -v '\.test\.ts' | grep -v test-support` prints `rules.ts` (`dayDate`) and `filters.ts:71` (`spanDays`) only.
    - `grep -c '"P2025"' hours-api/src/entries/entries.routes.ts` prints `1`.
    - `write.test.ts` (the day rule at `:122`, the PATCH race to 404 at `:587`, DELETE at `:404`), `list.test.ts` (from/to and the cursor), `apply.test.ts` and `automatic.test.ts:224` (second DELETE gives 404) pass unchanged.
    - `cd hours-api && bun run typecheck && bun test` is green.
- **S5 [BE] hours-api: the DELETE's block rule in `meetingHours/blocks.ts`.** Refs: AC-2.5. Deps: S4.
  - touch: `hours-api/src/meetingHours/blocks.ts` (new), `hours-api/src/entries/entries.routes.ts`, `hours-api/src/entries/automatic.test.ts`.
  - new tests in `automatic.test.ts`, under the DELETE describe (`:159`):
    - (a) "a block the database refuses takes the delete back with it: 500, the entry still there, no block".
      - A temporary `BEFORE INSERT` trigger on `meeting_hours_block` that raises, created and dropped in `finally`, as `apply.test.ts:691-703` does.
      - Mutation: a `try/catch` that swallows the insert ("best effort"). It does not commit the delete. Prisma's interactive transaction opens no savepoint, so the failed insert aborts the Postgres transaction and its COMMIT becomes a rollback. The mutated route answers 204 while the entry is silently still there, with no block: the person is told it is deleted, and it is not. The test is red on the 204.
    - (b) "writes the block on the DELETE's own transaction: a delete the database refuses at commit leaves no block behind".
      - A temporary constraint trigger on `time_entry` (`AFTER DELETE … DEFERRABLE INITIALLY DEFERRED`) that raises at COMMIT, after the block's insert has gone through. It is dropped in `finally`.
      - Mutation: the block written on the shared `db` instead of `tx` (after the refactor, `blockDeletedEntry(db, …)`). A block on the shared client commits on its own connection, so it is left behind beside an entry that is still there. This is the test that tells `tx` from `db`.
  - done when:
    - `grep -rn 'meetingHoursBlock' hours-api/src/entries --include='*.ts' | grep -v '\.test\.ts'` prints nothing.
    - The DELETE calls `blockDeletedEntry(tx, …)` with its own transaction's `tx`: `grep -n 'blockDeletedEntry(db' -r hours-api/src` prints nothing. Test (b) is the behavioural proof, and this grep is the second.
    - The two new tests pass, and `automatic.test.ts:159-270` and `apply.test.ts:618` (the race) pass unchanged.
    - The hours-api command of S4 is green.
- **S6 [BE] meetings-api: qualified `AC-4.10`.** Refs: AC-4.1, specs/20261104-meetings AC-4.10. Deps: none. Parallel with S1, S3, S4, S5.
  - touch: `meetings-api/src/hours/delivery.ts`, `meetings-api/src/hours/client.ts` (comments only).
  - done when:
    - `grep -n 'AC-4.10' meetings-api/src/hours/delivery.ts meetings-api/src/hours/client.ts` shows each occurrence preceded by `specs/20261104-meetings`.
    - The step's own commit is comment-only (as tasks.md T20): `c=$(git log -1 --format=%H --grep='(T20, specs/20261112-meeting-hours)'); git diff "$c^" "$c" -U0 -- meetings-api/src/hours/delivery.ts meetings-api/src/hours/client.ts | grep -E '^[-+][^-+]' | grep -vE '^[-+]\s*(\*|//)'` prints nothing.
    - The check reads T20's commit against its parent. S2 (T21) changes code in `delivery.ts` by design, so a diff from `3bf7c402` cannot be empty at HEAD, and a working-tree diff is empty for any change that is already committed.
    - `cd meetings-api && bun run typecheck` is green.
- **S7 [QE] gates.** Deps: S1–S6.
  - touch: none.
  - done when: the three app commands above are green, `mise run shared:check` is green, and `node scripts/check-changeset.mjs --base=$(git merge-base HEAD origin/main) --head=HEAD` prints OK. Run it this way because local `main` is behind `origin/main`, so `mise run changeset:check` would compare against an older base.
  - Every check of I1 to I9 holds: the empty diffs of I2 and I4, I8's zero deleted test lines, and the `shared:check` of I3.

### Test strategy

| Invariant | Existing tests (unchanged) | Added by this amendment |
|---|---|---|
| I1 wire and wire order | `deliverHoursNotice.test.ts:93-148` (`toEqual` on the whole body), `triggers.test.ts` (each path's delivered facts), `client.test.ts`; hours-api `meetingHoursWire.test.ts`, `notices.routes.test.ts`, `openapi.contract.test.ts`; `mise run shared:check` | S2 order tests: the delivery test (red under an added `.sort()`; it cannot see a dropped `orderBy`, because the unique index already returns that order) and `hours/participants.test.ts` (red under a dropped `orderBy`, with index scans off through `SET LOCAL`) |
| I6 / I7 the lock and the snapshot | `prepareAudio.measured.test.ts:232` (held duration read in the commit), `record.test.ts:59-204` (the compare, deletion, rollback), `triggers.test.ts` (seven paths, one notice each) | S1 (a) lock held, S1 (b) `null` not 404 |
| I7 `lockMeeting`'s 404 | the route suites that lock (core, participants, delete, consent, agenda, attachments, retry), all in the meetings-api run | — |
| I5 badge DOM and copy | `EntryRow.test.tsx`, `EntryRow.it.test.tsx`, `EntriesTable.test.tsx`, `EntriesTable.it.test.tsx`, `TableView.fromMeeting.test.tsx`, `noHardcodedStrings.test.ts`, `strings.test.ts` | S3 tone test |
| I7 day conversion | `write.test.ts:122`, `list.test.ts`, `apply.test.ts` (entry days), `automatic.test.ts` | S4 vector |
| I7 P2025 | `write.test.ts:587` (PATCH race to 404), `automatic.test.ts:224`, `write.test.ts:404` | — |
| I6 the DELETE's block | `automatic.test.ts:159-270` (one transaction at `:233`, existing block kept at `:213`), `apply.test.ts:618` | S5 (a) rollback test (red when the insert is swallowed: 204, the entry still there); S5 (b) `tx` not `db` (a constraint trigger deferred to COMMIT) |
| I4 logs | `meetings-api/src/logPrivacy.test.ts`, `client.test.ts:190`, `apply.test.ts` (log line) | — (diff check in S7) |

Suites and commands:
- **meetings-api:** `cd meetings-api && bun run typecheck && DATABASE_URL=postgresql://postgres:postgres@localhost:5435/meetings_test bun test`.
  - Always set `DATABASE_URL` explicitly. `src/test-support/testEnv.ts:11` only defaults it (`??=`), so a shell where direnv has loaded meetings-api's `.envrc` would truncate the dev database.
  - Never run `bun test` from the repo root.
  - Migrate `meetings_test` first only if it is behind (`DATABASE_URL=… bun run db:deploy`); this amendment adds no migration.
- **hours-api:** `cd hours-api && bun run typecheck && bun test`. Its preload forces `hours_test` (`src/test-support/env.ts:26-32`).
- **hours-ui:** `cd hours-ui && pnpm lint && pnpm exec tsc -b && pnpm test`.
- **Repo-wide:** `mise run shared:check`, and the changeset check of S7.
- **Not run:**
  - auth and tools/env-doctor: untouched.
  - The e2e (`shell/e2e/meeting-hours*.spec.ts`): no wire, DOM or copy change, and it needs the whole stack. QE may run `cd shell && pnpm e2e meeting-hours.spec.ts` if the stack is up.

### Changeset

No new changeset. `.changeset/meeting-hours-automatic-entries.md` is already added on this branch and names `@operai/hours-api`, `@operai/meetings-api` and `@operai/hours-ui` (minor). The cleanup lands in the same unreleased PR #12, before any release of that changeset.

`node scripts/check-changeset.mjs --base=a17c260f --head=HEAD` answers OK today ("matched changeset(s): .changeset/meeting-hours-automatic-entries.md"). Because the branch diff keeps adding that file, the check stays OK after S1–S6.

A patch changeset would add a CHANGELOG line describing no change, and the release would still bump each app minor. tools/env-doctor is no longer touched (S6 leaves `manifest.ts` alone), and it is not a Changesets package.

### Security

**Security-sensitive: YES, a delta pass only.** There is no new surface: no new route, credential, outbound call, data, wire field or log line. But S1 and S5 move two integrity controls that the feature's security review relied on:
- `readHoursFacts`' row lock: owasp-report.md Q5, "the row-lock read keeps the decision safe".
- The DELETE's same-transaction block: AC-2.5, and plan § Applying a notice, "The person's writes".

Both fail silently when moved wrongly:
- A stale snapshot announces nothing for a change that happened.
- A block written outside the DELETE's transaction no longer commits with the delete. On the shared client it commits first and stays even when the delete then fails. Written after the commit, a failed insert leaves an entry deleted with no block, and the next notice records it again.
- A swallowed insert failure is no better. Prisma's interactive transaction has no savepoint, so Postgres has aborted the transaction and its COMMIT becomes a rollback: the person gets a 204 for an entry that is still there.

Orchestrator: schedule an owasp-reviewer delta pass in parallel with QE, over:
- `meetings-api/src/meetings/lock.ts` and `meetings-api/src/hours/record.ts` (`readHoursFacts`);
- `hours-api/src/meetingHours/blocks.ts` and the DELETE handler of `hours-api/src/entries/entries.routes.ts`.

What it checks:
- the same SQL and statement order;
- `tx` and never `db`;
- no lock added to the DELETE (decisions T5);
- `null`, never 404, for a missing meeting.

For S2, S3, S4 and S6 it only confirms from the diff that no wire field, log line or copy changed. Not regulated data; standard tier.

### Risks of this amendment

- **RA1 A step changes what reaches Postgres or the wire while every existing test stays green.** The cases are the two orders, the lock, and a block that leaves the transaction.
  - Mitigation: the characterisation tests (S1 a/b, S2's delivery test and `participants.test.ts`, S5 a/b), each shown red under its mutation before the refactor, plus the S7 diff checks. The exception is `participants.test.ts`: it tests the new export, so it is shown red once the reader exists.
  - Early check: S1 and S2 are the first meetings-api steps.
- **RA2 A meetings-api test run hits the dev database.** Mitigation: the explicit `DATABASE_URL` in every command.
  - tasks.md's "Test commands" sentence ("each preload rewrites `DATABASE_URL`") is true of hours-api only. `/wellforge:tasks` must copy the meetings-api command from here.
- **RA3 Commits after QE, owasp and eval PASS make those verdicts stale for the touched files.** Mitigation: S7 reruns QE's suites, and the owasp delta covers S1 and S5. Whether the eval reruns is the orchestrator's call: the rubric's evidence paths change only by line numbers.

### ADR candidates

None. Each step places code inside decisions already recorded: ADR 20261124-meeting-hours-facts-pushed-by-their-owner-… and ADR 20261124-a-system-written-time-entry-follows-its-source-fact-only-…. The one choice with a rejected alternative, S1 keeping the lock inside the reader rather than trusting the caller, restates § Where meetings-api records a notice. It does not constrain new work. No glossary candidate.

### Not done (owner declined)

- A `withHoursNotice` wrapper for the seven `readHoursFacts` / `recordHoursNotice` call sites.
- Making `meetings-api/src/hours/recordDay.ts`'s Zurich-day rule a shared copy with hours-api's `src/entries/today.ts`.
- Shared e2e helpers for `shell/e2e/meeting-hours*.spec.ts`.
- Shortening `.changeset/meeting-hours-automatic-entries.md`.
- Sending `origin` only to the entry's owner (the wire stays as it is, owner decision 2026-11-25, ledger D77; § Security already says so).

### Observed, not planned (outside the owner's list)

- `meetings-api/src/transcript/transcript.routes.ts:242` keeps an older copy of the lock statement as its own local `lockMeeting`, from specs/20261104-meetings and not this feature's diff. It could use `lockMeetingRow` / `lockMeeting` after S1.
- `hours-api/src/lists/lists.routes.ts:159` `isUniqueViolation` (P2002) has the same shape as S4's `isRecordNotFound`. A shared Prisma-error helper would be a change to time-tracking code.
- `hours-api/src/meetingHours/apply.ts:141` (the `had_entry` insert) is the other writer of `meeting_hours_block`. It could call into `blocks.ts`, but its count feeds the log line.
- `meetings-api/src/hours/client.test.ts:190` has the same unqualified `AC-4.10` in a `describe` title. It is left because I8 lets test text change only to follow a moved symbol. The owner may add it to S6.
- The inverse conversion, a `Date` back to `YYYY-MM-DD` (`hours-api/src/entries/view.ts:171`, `list.routes.ts:62`, `totals/totals.ts:18`, `meetingHours/apply.ts:118`), repeats too. It is not item 4.
