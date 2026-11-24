---
spec: 20261112
status: approved
approved: 2026-11-24
---

# Plan: Meeting hours — the hours of a meeting recorded automatically for the people who took part

Spec: `specs/20261112-meeting-hours/spec.md` (approved 2026-11-24, ledger D54–D62). Builds on
specs/20261112-time-tracking (hours-api, hours-ui) and specs/20261104-meetings (meetings-api); no screen of its own.
Design: `design.md` (the mark's placement, tone and copy win over this plan's § hours-ui sketch).

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
counts them with no change (AC-2.2). hours-ui shows a "From meeting" badge from the new `origin` field.

### Components

| Component | Change |
|---|---|
| **meetings-api** | `Meeting.hoursSeq`; table `hours_notice`; `JobKind` gains `deliver_hours_notice`; `src/hours/notices.ts` (`recordHoursNotice`, called from seven write paths, below); `src/hours/client.ts` (`sendHoursNotice`); `src/jobs/handlers/deliverHoursNotice.ts`; env `HOURS_API_URL`; a migration that also enqueues the release backfill |
| **hours-api** | three `time_entry` columns + CHECKs + a partial unique index; tables `meeting_hours_meeting`, `meeting_hours_block`, `meeting_hours_release`; `src/auth/systemAuth.middleware.ts` (a byte-identical copy of meetings-api's, added to the `systemAuth` group of `scripts/check-shared-copies.ts`); `src/meetingHours/` (`desired.ts` pure, `apply.ts`, `notices.routes.ts`); the PATCH and DELETE handlers of `src/entries/entries.routes.ts` (`:351-363`, `:377`); `TimeEntryView.origin` in `src/entries/view.ts` |
| **hours-ui** | `origin` on `TimeEntryView` (`src/lib/hoursApi.types.ts:42-57`); a "From meeting" `Badge` in `src/components/EntryRow.tsx` (List and table cell dialog) and in `src/components/EntriesTable.tsx` (Everyone's hours); a second paragraph in `src/components/DeleteEntryDialog.tsx` for an automatic entry (AC-2.7); strings in `src/strings/entries.ts` and `src/strings/entry.ts` (en + it) — placement and copy per `design.md` |
| **both services** | `src/lib/meetingHoursWire.ts`: the notice body's zod schema and caps, a byte-identical copy in meetings-api and hours-api (new `meetingHoursWire` group in `scripts/check-shared-copies.ts`) |
| **auth** | scope `meeting-hours-notices.send` in `KNOWN_SERVICE_SCOPES` (`auth/src/system/serviceClients.ts:78`), documented; the prescribed scopes of client `meetings-api` gain it |
| **tools/env-doctor** | meetings-api `HOURS_API_URL` (required in production); the meetings-api `SERVICE_CLIENTS` scope set; hours-api `SERVICE_AUDIENCE` now verifies something (already required) |
| **AGENTS.md** | Time tracking glossary (automatic entry), hours-api and meetings-api descriptions, the service-client scope list |

Nothing changes in crm-api, projects-api, activities-api, notify-api or the shell.

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
| `prepare_audio` fills a null duration | `src/jobs/handlers/prepareAudio.ts:250-259` (only when it wrote it) | `durationMs` set |
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

**The person's writes** (the only other writers of these rows):
- PATCH (`src/entries/entries.routes.ts:351-363`): every successful PATCH also sets
  `followsMeeting = false` (A39: any saved change). A refused PATCH writes nothing, so the entry stays
  untouched (AC-2.4).
- DELETE (`:377`): becomes an interactive transaction — delete the caller's own entry `RETURNING
  "sourceMeetingId"`; when non-null, insert block `(sourceMeetingId, userId, deleted)` `ON CONFLICT DO
  NOTHING` (AC-2.5). The block commits with the delete, and apply's one-statement read (step 4) sees that transaction
  whole or not at all: whenever that read runs, it sees the entry or the block, never neither. The DELETE takes none of
  apply's locks.
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
migration is planned for so rare a case.

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
   404, which is transient, and are delivered once it exists; `since` is hours-api's own release day.
3. **hours-ui** any time: a `TimeEntryView` without `origin` (an older hours-api) reads as `person`.

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
- **D-P5 The mark is shown in Everyone's hours too** (`EntriesTable`), as AC-2.3 says "wherever entries
  are listed one by one"; the export file is unchanged (no column added to D39/D40's nine).

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
  are never returned: they decide what Operai does, not what the person sees.
- **`PATCH /time-entries/{id}`**: request, rules and errors unchanged; a 200 now also means the entry no
  longer follows its meeting.
- **`DELETE /time-entries/{id}`**: request and errors unchanged; deleting an automatic entry also blocks
  it from coming back (AC-2.5).
- List, totals and export: unchanged contracts; automatic entries are rows like any other.

### meetings-api — outbound (new)

`sendHoursNotice(notice, tokens)` → the request above. Outcome mapping in § Delivering a notice. Env:
`HOURS_API_URL` (`src/lib/env.ts`): URL, required when `NODE_ENV=production`, default
`http://localhost:8090` otherwise; listed in env-doctor's manifest for meetings-api.

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
read as `person`). For `origin === 'meeting'` only (anything else, `undefined` included, renders nothing new):
- `EntryRow` and `EntriesTable` render `<Badge tone="accent">{strings.entries.fromMeeting}</Badge>` — in `EntryRow` right
  after the kind badge, before the name; in `EntriesTable`'s On cell on the name line, before the name, outside the `<p>`
  lines its tests read (design S1, S2). en "From meeting", it "Da riunione" (D60).
- `DeleteEntryDialog` adds a second paragraph after the existing sentence, `strings.entry.delete.automaticNote`: en "Operai
  won't record it again from its meeting. You can still record hours yourself.", it "Operai non la registrerà di nuovo dalla
  riunione. Puoi comunque registrare le ore tu." (design S4, AC-2.7).

## Test strategy

Levels: **U** unit (pure), **I-H** hours-api integration (real Postgres `hours_test`, `world.ts`/`hosts.ts`),
**I-M** meetings-api integration (real Postgres `meetings_test`, `routeKit`, `createRunner` with manual
`tick()`, a fake hours-api recording what it receives), **C** hours-ui component (Vitest), **E** e2e in
`shell/e2e/` (new `meeting-hours.spec.ts`, the real recorder with the fake microphone of
`meetings-capture.spec.ts`).

| AC | Level | Test |
|---|---|---|
| AC-1.1 | U, I-H, I-M, E | U: `desiredEntries` gives creator + each participant the Zurich day and rounded minutes. I-H: a notice with facts creates one `origin: meeting`, following entry per person, on the meeting. I-M: stop a recording / confirm an upload / `prepare_audio` filling a null duration each records one notice + job; the delivered body carries `startsAt`, `durationMs`, `creatorId`, `participantIds` and the current `hoursSeq`. E: a creator records a short meeting with one Operai participant; after Stop, once the notice is delivered, each opens (or reloads) My hours and sees a 30-minute entry on the meeting — never a live update (design G5) |
| AC-1.2 | U, I-H | creator also in `participantIds` → one entry |
| AC-1.3 | U, I-H, I-M | U: `durationMs` null or 0 → nobody (D-P4). I-H: a notice with `durationMs: null` creates nothing; the next with a duration creates. I-M: a text meeting records no notice; `prepare_audio`'s too-long refusal records one whose facts carry `durationMs: null`, and I-H removes the untouched entries |
| AC-1.4 | I-H | a person with a hand-made entry on the meeting gets block `had_entry` and no automatic entry; after deleting the hand-made one, a newer notice still creates none |
| AC-1.5 | U, I-H | U: `day < since` → nobody. I-H: the migration's `since` is the Zurich date; a meeting starting the day before creates nothing |
| AC-1.6 | I-H | route matrix (`src/matrix.test.ts`): only `system:meetings-api` with the scope reaches the route; activities-api and crm-api are unchanged (no new caller exists) |
| AC-1.7 | I-H | a user JWT (admin, read-all holder) on the system route → the one 401; time-tracking's `owner_only` / 404 tests still pass; an applied entry's `userId` is the participant's |
| AC-1.8 | I-H | an automatic entry has no work type, passes the minutes CHECK, and on a meeting linked to a deal counts in `GET /time-entries/totals?groupBy=deal` for that deal |
| AC-2.1 | C, E | C: `TableView` cell sum and the List include an `origin: meeting` entry. E: as AC-1.1, in the table view and the List |
| AC-2.2 | I-H | `whose=all` list, totals and a `dealId` filter include automatic entries |
| AC-2.3 | C, I-H | C: `EntryRow` (List and cell dialog) and `EntriesTable` (Everyone's hours) show the mark for `origin: meeting`, in both languages, and not for `person` or a missing `origin`; `EntriesTable.test.tsx`'s `lines()` still read the same lines. I-H: after a PATCH the view still says `origin: meeting` |
| AC-2.4 | I-H | a PATCH of day, minutes or note on an automatic entry is saved and clears `followsMeeting`; a refused PATCH (future day, 45 min) changes nothing and the entry still follows; a later notice changes neither |
| AC-2.5 | I-H | DELETE of an automatic entry (touched or not) writes block `deleted`; newer notices — same facts, participant removed and re-added — never recreate it |
| AC-2.6 | I-H | applying makes no outbound HTTP call (`hosts.calls()` empty); hours-api has no notify client |
| AC-2.7 | C | `DeleteEntryDialog` for `origin: meeting` shows the second paragraph (en, it) after the existing sentence; for `person` and a missing `origin` the dialog's text is exactly today's |
| AC-3.1 | I-H, I-M | I-H: newer notice with another `startsAt` moves the untouched entry's day. I-M: PATCH with a new `startsAt` records a notice; a title-only PATCH records none |
| AC-3.2 | I-H, I-M | I-H: a new `durationMs` resizes the untouched entry. I-M: the `prepare_audio` fill records a notice |
| AC-3.3 | I-H, I-M | I-H: a participant missing from the newer facts loses the untouched entry and gets no block; the creator, absent from `participantIds`, keeps theirs. I-M: a participants PUT that changes the userId set records a notice; one that only changes externals records none |
| AC-3.4 | I-H, I-M | I-H: `facts: null` removes every untouched entry. I-M: DELETE writes a `deleted` notice in its transaction; it survives the cascade (no FK) and is delivered after commit, also via the `meeting:erase` path |
| AC-3.5 | I-H | a changed entry is untouched by newer notices with another day or duration; a concurrent apply and PATCH leave the PATCH's values (the `AND "followsMeeting"` CAS, driven by two connections) |
| AC-3.6 | I-H | a changed entry stays when its person is removed or `facts: null`; with the fake meeting removed, its view has `visibility: hidden`, no label |
| AC-3.7 | I-H | a person added in a newer version gets an entry, unless blocked `had_entry` or `deleted` |
| AC-4.1 | I-H | the automatic entry's `note` is null; the strict body refuses an extra `title` key (400) |
| AC-4.2 | I-M, I-H | I-M: fake hours-api answers 503 then 200 → the row is retried with the backoff and delivered once; a 400 settles it as `failed`; channel disabled → nothing recorded. I-H: the same notice twice and an older `seq` after a newer one → one entry, `applied: false` for the older; My hours loads with the meetings fake down (existing) |
| AC-4.3 | C | catalog parity (`catalogGaps`) and `noHardcodedStrings` cover the new string |

Also: U vectors for A36 (1 ms → 30, 44:59.999 → 30, 45:00 → 60, 1:14:59 → 60, 1:15:00 → 90, 23:44:59 → 1410,
23:45:00 → 1440, 30 h → 1440) and A35 (23:30 UTC on a winter and a summer day). I-M for A37: a `startsAt`
on a later Zurich day enqueues a second job due at 00:01 Zurich that day; I-H: that day's re-delivery
(equal `seq`) creates the entry. `scripts/check-shared-copies.ts` covers the hours-api copy of
`systemAuth.middleware.ts`. auth: the scope-list and prescribed-scope tests.

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

## Security

**Security-sensitive: YES** — schedules an owasp-reviewer pass in parallel with QE.

- **New authentication path in hours-api**: its first route that accepts a service JWT. Verified exactly
  as meetings-api's system routes (shared middleware copy): RS256, issuer, `aud = SERVICE_AUDIENCE` (≠
  `AUTH_AUDIENCE`), scope `meeting-hours-notices.send`, `sub` allowlist `system:meetings-api`, one 401 for
  every failure, checked before the body. The matrix test fails on any unpinned `/system/` route.
- **Writes on a person's behalf** (D14 narrowed): only from facts the owner of the meeting states; only
  for the meeting's creator and Operai participants; only on the meeting; at most one per person and
  meeting (unique index); never after the person deleted it. No user, admin or read-all holder gains a
  write (AC-1.7).
- **Abuse by a meeting's creator**: they can add colleagues as participants and so give them hours on a
  meeting — the same trust Meetings already places in the creator's participant list (validated active,
  ≤ 30); each person can delete theirs. The creator also controls the two other facts an entry is built
  from, and neither is checked against the audio:
  - **Duration.** A recording's is the sum of the per-chunk durations the browser reports when it confirms each
    chunk (each ≤ 15 s, `MAX_CHUNK_MS`; the meeting's total ≤ `MAX_RECORDING_MS` = 3 h 1 min, a confirm past it
    refused, `meetings-api/src/capture/recording.routes.ts:33, :269`), never compared with the stored bytes (a chunk
    need only be an object of 1 B–8 MiB, `src/lib/storage.ts:260`) or with the decoded audio. An upload's is the
    container's own claim as ffprobe reads it (≤ `MAX_AUDIO_MS` = 3 h, refused beyond, `src/media/probe.ts:34`).
    `prepare_audio` writes the decoded duration only when none was stored (`src/jobs/handlers/prepareAudio.ts:262`;
    the decode itself is held to 3 h 1 min), so a claimed duration stands even if processing later fails. An
    automatic entry is therefore at most **180 minutes** per person and meeting (A36's rounding of 3 h 1 min); A36's
    24-hour clamp is never the binding bound.
  - **Start.** `startsAt` is set at create (default now) or by a PATCH (`src/meetings/core.routes.ts:129, :201`), to
    any instant. It decides the day of every participant's entry, bounded by the release day (AC-1.5) and today
    (A37), and a PATCH moves every untouched entry with it.

  So a forged client gains nothing that recording 3 h of real silence with 30 colleagues does not already allow: at
  most 3 h for each of at most 31 people per meeting, on a day of the creator's choosing within those bounds. Each
  participant is notified when added, sees the entry marked "From meeting", and can change it, or delete it for good. The
  creator-trust model of AC-1.7 and D54–D57 stands (security review L1, low).
- **Personal data in transit**: attendance (who, when, how long) crosses services — the minimum the
  feature needs; no title or content (AC-4.1). The outbox stores no personal data (ids built at send);
  hours-api stores only what an entry already holds plus `meeting_hours_block` (meeting id, user id,
  reason). Logs carry no user id.
- **For the reviewer (design G6, low)**: in Everyone's hours the mark stays on an entry its person moved
  off the meeting, so a `time-entry:read-all` holder learns the person attended a meeting that day for
  about that long. Attendance, not content; accepted as AC-2.3 reads (D62). The alternative is a one-line
  condition (`on.type === 'meeting'`) in that table only.
- **Labour-law go-live sign-off (spec O3, accepted as risk)** — automatic recording of hours about a
  person: management / HR before go-live.
- No new external host, no data-residency change.

## ADR candidates

Both written 2026-11-24 (paths in § Decisions this plan makes) and indexed in AGENTS.md.

1. **A meeting's hours facts reach hours-api as a versioned state its owner builds at send time,
   through an until-delivered outbox, and hours-api applies only a version not older than the one it
   holds** (D-P1), with the release backfill enqueued by meetings-api's migration and filtered by
   hours-api's migration-stamped release day. Rejected: read-back route, derived-on-read entries, pull
   feed, coalescing; an operator-run backfill script.
2. **A record that is a person's own declaration may be written by the system only from a fact its
   owner states, follows that fact only until the person changes it, and is never written again once
   the person removed it** (D-P2, D14 narrowed by D54–D56). Rejected: value comparison for "untouched",
   a soft-delete tombstone in `time_entry`, recreation after delete.
