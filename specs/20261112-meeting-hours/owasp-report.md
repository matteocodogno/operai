verdict: PASS

# OWASP Top 10 review: specs/20261112-meeting-hours (T13)

- Branch `feat/meeting-hours`, diff `831bf3fb..HEAD`, reviewed 2026-11-24 by the owasp-reviewer.
- Stack: Bun + Hono + Prisma services (hours-api, meetings-api, auth) and the React hours-ui, so JPA/jOOQ checks do not apply.
- Plan § Security is the checklist; plan § API contracts and § Risks and design G6 were read with it.
- **Result: 0 critical, 0 high, 0 medium, 1 low, 8 info.** Nothing at medium or above, so the verdict is PASS. The one low finding (L1) corrects a statement in the plan and offers an optional hardening step. G6 is recorded as **accepted** (I8).

## How this was verified

Beyond reading the diff, I ran the following. Nothing in the repository was edited (`git status` is clean).

- **Test subsets.**
  - hours-api, run against a fresh database migrated with this branch's migrations: `src/meetingHours`, `src/auth`, `src/matrix.test.ts`, `src/entries/automatic.test.ts`, `src/db.constraints.test.ts`. 497 pass, 0 fail.
  - meetings-api (`src/hours`, the `deliverHoursNotice` test, `env.test.ts`): 161 pass, 0 fail.
- **Shared copies.** `bun scripts/check-shared-copies.ts` reports 35 groups in sync. `meetingHoursWire.ts` is byte-identical in both services. The `systemAuth` region of hours-api matches meetings-api's.
- **Adversarial probes through the assembled hours-api app** (throwaway test file in the session scratchpad, not in the repo). All pass:
  - Rejected with 401: a token signed with a foreign key and no `exp`; `alg: none`; HS256 signed with the public JWK as the secret; the user audience carrying the right `sub` and scope; a `sub` with a trailing space; a scope that is a superstring of the real one (`...send2`); a scope with a tab-injected token; a lower-case `bearer` scheme.
  - Rejected with 400 and nothing written: a `__proto__` key in the body.
  - `\n` and ESC in `noticeId` and `meetingId` reach the log escaped, as an object payload.
  - A NUL byte in an id produces a generic 500 (see I3).
- **Prisma error-log probes** (for the Prisma note) against a scratch database migrated with this branch's migrations.

## Plan § Security, point by point

### 1. hours-api's first service-JWT route (`POST /system/meeting-hours/v1/notices`): MET

- **One identical 401.** Every failure goes through the single `unauthorized(path)` helper (`hours-api/src/auth/systemAuth.middleware.ts:80,82,99,103,110`). Each probe above returned the same body.
- **Checked before the body.**
  - `@hono/zod-openapi` 1.6.3 registers `...middleware, ...validators, handler` (`node_modules/@hono/zod-openapi/dist/index.mjs:163-164`).
  - The guard is attached per route via `createRoute({ middleware })`, never `use("*")`.
  - The 415 media-type gate is a validator, so it also runs after the guard. The test "a bad credential with an unknown key, a title or non-JSON text is a 401" passes.
  - The global 64 KiB `bodyLimit` (`hours-api/src/index.ts:47`) runs first, so an oversized body gets 413 with or without a credential. It reads no body and says nothing about credentials.
- **Mounted before the user gate.** The notices router is mounted at `index.ts:67`, `jwtMiddleware` at `index.ts:76`.
  - `matrix.test.ts` asserts that exactly one route exists under `/system/`.
  - GET/PUT/PATCH/DELETE on the path, a trailing slash, sub-paths and `/system/anything` all fall to default-deny 401.
  - A service JWT on a user route gets 401.
  - A session of any role on the system route gets 401 and writes nothing.
- **Credential checks.**
  - RS256 only (`algorithms: ["RS256"]`), issuer pinned, `requiredClaims: exp, sub, aud, iss`.
  - `aud` is `SERVICE_AUDIENCE`. `env.ts` refuses a value equal to `AUTH_AUDIENCE` and refuses start without it; the middleware also fails closed when it is unset.
  - `sub` must start with `system:` and be exactly `system:meetings-api` (`NOTICES_ALLOWED_SUBS`).
  - The scope is an exact token match on the space-split claim.
  - The matrix test drives ten other service principals holding the scope; all get 401.

### 2. Writes on a person's behalf, bounded and blocked after a delete: MET, with one honest note

**What hours-api enforces itself.** Entries are written only from `facts` in a strict body. The controls are:
- `desiredEntries` empties the result for a null duration, a duration of 0, a day before the release day, or a day after today.
- Minutes are clamped to 30..1440.
- A partial unique index guarantees one automatic entry per person and meeting (`migration.sql`, `time_entry_one_automatic_per_meeting`).
- `time_entry_origin_shape` and `time_entry_follows_shape` are CHECK constraints.
- `origin`, `sourceMeetingId` and `followsMeeting` are not client-writable: the POST and PATCH schemas are strict and `entries.routes.ts` writes explicit columns.
- No user, admin or read-all holder gains a write. PATCH and DELETE stay scoped to `where: { id, userId }`.

**The trust boundary.** Whether the people in `facts` really took part is not checked by hours-api. That is the design (D-P1), and the bound is the credential: `sub`, scope and audience. A holder of meetings-api's credential could write an entry for any user id on any meeting id between the release day and today. See I2.

**Blocked after a delete.**
- The DELETE (`entries.routes.ts:389-407`) removes the entry and inserts the block `deleted` in one transaction. The block key comes from the row's `sourceMeetingId` and the JWT `sub`, never from the client.
- `apply()` reads entries and blocks in one `UNION ALL` statement (`apply.ts:86`), so it sees the entry or the block, never neither.
- I walked every interleaving. DELETE before the snapshot: block seen, no create. DELETE after the snapshot: the entry was seen, so no create. An apply delete or update racing a person's PATCH: the `AND "followsMeeting"` compare-and-set makes it match 0 rows.
- `apply.test.ts` drives the DELETE-vs-apply race 20 times and the PATCH-vs-apply race 15 times through the route, with the delete landing in every phase. Both pass.

### 3. The creator's participant list and the client-reported duration as the only inputs: PARTLY ACCURATE, see L1

The inputs are three, not two, and the plan's cap statement is wrong.
- **Participant list.** The creator can add at most 30 users (`participants.routes.ts:28,76`). Each is checked live as an active Operai user, as the caller and failing closed. Added users get an in-app `participant_added` notification (`:131`). This matches the trust Meetings already places in the creator.
- **Duration.** The real cap is about 3 h, not 24 h (L1).
- **`startsAt`.** It is a third creator-controlled input the plan does not list (L1, I4).

### 4. No personal data in the outbox rows or the logs: MET

- **Outbox rows.**
  - `hours_notice` holds `id, meetingId, seq, kind, state, attempts, lastErrorCode, createdAt`.
  - `meeting_job` holds `noticeId` and no `meetingId`.
  - Failure codes are a closed vocabulary (`http_<n>`, `timeout`, `transport`, and so on).
  - The runner stores only the code.
- **Logs.**
  - meetings-api logs `meeting_hours.notice_delivered|retry|refused` with a meeting id and a closed code (`meetings-api/src/hours/delivery.ts:110,134,143`).
  - hours-api logs `meeting_hours.applied` with `noticeId`, `meetingId`, `seq` and counts (`apply.ts:167`), `[system-auth] ... caller=system:meetings-api`, and the request logger (path only).
  - No user id, title, token or body appears in any of them. Control characters in the client-supplied ids are escaped (probe).
  - The 400 body names members and rules, never values.
- **Storage.** hours-api's new personal-data-bearing table is `meeting_hours_block` (meeting id, user id, reason). See I6.

### 5. The strict body: MET

`meetingHoursWire.ts:42-59` uses `z.strictObject` at every level. `facts` is required (`null` must be written out), ids are 1..64, `participantIds` are at most 100 and distinct, `startsAt` is ISO with offset, and `seq` and `durationMs` are bounded integers.
- A `title`, an external participant or any unknown key gives 400 `invalid_request`.
- I confirmed that `__proto__` is refused and nothing is written.
- Every raw SQL statement is a tagged template with bound parameters, in `apply.ts` and meetings-api `record.ts`. No SQL injection surface was found.

### 6. Design G6: ACCEPTED, see I8

## Findings

### L1: LOW: A04 Insecure Design: creator-controlled inputs; the plan overstates the duration bound

- **Files:**
  - `meetings-api/src/capture/recording.routes.ts:33,35,269,287,391`
  - `meetings-api/src/lib/storage.ts:260`
  - `meetings-api/src/media/probe.ts:34,227`
  - `meetings-api/src/jobs/handlers/prepareAudio.ts:262`
  - `meetings-api/src/meetings/core.routes.ts:129,201`
  - plan.md § Security, "Abuse by a meeting's creator"
- **Evidence.**
  - The plan says the duration is "client-reported per chunk (≤ 15 s each), so a forged client cannot exceed its stored chunks; the entry is capped at 24 h".
  - The real caps are tighter than stated. The recording's total is limited by `MAX_RECORDING_MS = 3 h 1 min` (`:33,:269`) and an upload by `MAX_AUDIO_MS = 3 h` (`probe.ts:34`). Rounding makes that at most 180 minutes per person per meeting. The 24 h is only the entry rule's ceiling.
  - The "stored chunks" bound is weak. A chunk only has to exist as an object of 1 to 8 MiB (`storage.ts:260`, `content-length-range 1`). Its reported `durationMs` is never compared with its bytes or with decoded audio. About 722 one-byte chunks reported at 15 s each, then Stop, yield `durationMs` of about 3 h at `beginProcessing` (`:391`), and the notice is recorded in that same transaction.
  - `prepare_audio` writes the decoded duration only when the stored one is null (`prepareAudio.ts:262`). Entries therefore stay even if processing later fails as `audio_unreadable`. An upload's probed duration is the container's own claim.
  - `startsAt` is a third creator input: it can be set at create or PATCH and decides the day of every participant's entry, anywhere from the release day to today.
- **Impact (why it is Low and not Medium).**
  - The capability is the same as recording 3 h of real silence and listing 30 colleagues, so the forgery adds nothing the honest path does not already allow.
  - The owner accepted the creator-trust model (spec AC-1.7, ledger D54-D57, plan § Security).
  - The effect is at most 3 h times 31 people per meeting.
  - Each victim is notified they were added, sees the entry marked "From meeting" in My hours, and can delete it for good. It is traceable to the creator through the meeting.
- **Fix.**
  - Required: correct the plan text, for example:
    > The recording duration is the sum of client-reported per-chunk durations (each ≤ 15 s, total ≤ MAX_RECORDING_MS = 3 h 1 min, not checked against the audio); an upload's is the container's claim (≤ MAX_AUDIO_MS = 3 h). An automatic entry is therefore ≤ 3 h per person and meeting; `startsAt` is a third creator input, bounded by the release day (AC-1.5) and today (A37).
  - Optional hardening, for the owner to decide. In the `prepare_audio` commit (`prepareAudio.ts:254-264`), also reconcile a materially wrong stored duration with the decoded one. `recordHoursNotice` already compares before and after and re-announces, so untouched entries are resized:
    ```ts
    const claimed = meeting.durationMs;
    const wrong = claimed !== null && Math.abs(claimed - durationMs) > Math.max(30_000, claimed * 0.1);
    data: { audioKey: ..., ...(claimed === null || wrong ? { durationMs } : {}) }
    ```
    Check the effect on the duration shown elsewhere in the UI first.

### I1: INFO: A09 Logging: a verified token refused for `sub` or scope leaves no log line

- **File:** `hours-api/src/auth/systemAuth.middleware.ts:99,103`. This is the shared region, byte-identical in all copies and unchanged by this feature.
- **Evidence.** Signature, algorithm and claim failures log a code (`:109`). A validly signed token with a wrong `sub` or scope returns 401 silently. My probes with a `sub` trailing space and with scope variants produced no line.
- **Fix** (all copies in one commit, then `mise run shared:check`):
  ```ts
  if (typeof sub !== "string" || ...) { console.warn("[system-auth] refused", { reason: "sub_not_allowed", sub: String(sub).slice(0, 80) }); return unauthorized(c.req.path); }
  if (typeof scope !== "string" || !scope.split(" ").includes(opts.scope)) { console.warn("[system-auth] refused", { reason: "scope_missing" }); return unauthorized(c.req.path); }
  ```

### I2: INFO: A01/A07: inherited credential blast radius, and the trust boundary stated plainly

- **Evidence.**
  - `auth` always mints a client's whole scope set. meetings-api's one token (`notifications.push host-notices.send meeting-hours-notices.send`) is also presented to notify-api and crm-api. Whoever holds it for up to 5 minutes can now also post notices to hours-api. The sub allowlist and scope are the only binding.
  - hours-api cannot verify the facts independently, so a credential holder could write entries for any user id on any meeting id between `since` and today, at most 100 users per call.
- **Fix.** None required for this change. It is the suite's existing service-token model. A possible hardening is per-request scope narrowing or a per-receiver audience in `auth POST /system/service-token`.

### I3: INFO: A03/A04 Input validation: wire ids have no character set, so a NUL byte is a retry-forever 500

- **File:** `hours-api/src/lib/meetingHoursWire.ts:34` (the same file in meetings-api).
- **Evidence.**
  - `z.string().min(1).max(64)` accepts a NUL byte. Through the route this gave a generic 500, because Postgres refuses `0x00`.
  - meetings-api treats 5xx as transient, so such a notice would retry every 30 minutes for that one meeting.
  - It is unreachable from the legitimate sender, because ids are server-made cuids or auth ids already validated as active. The log and the 500 body leak nothing.
- **Fix.** Change both copies in one commit, after confirming auth's user-id alphabet:
  ```ts
  const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);
  ```
  A malformed id then becomes a permanent 400 instead of a retry loop.

### I4: INFO: A04 Insecure Design: removals are as silent as creations; creator-driven write amplification

- **Evidence.**
  - Removal of an untouched entry (participant removed, meeting deleted or moved, duration changed) is silent, like creation (AC-2.6).
  - Each creator change of `startsAt` or participants that really changes a fact writes up to 2 `hours_notice` rows, 2 jobs and 1-2 apply transactions. A future day writes the second, delayed row (R6).
  - `recordHoursNotice` skips unchanged facts, and the cost is bounded by authenticated creator actions on one meeting. D-P1(d) rejected coalescing on purpose.
- **Fix.** None required.

### I5: INFO: A05 Misconfiguration: the public OpenAPI now documents the system route

- **Files:** `hours-api/src/meetingHours/notices.routes.ts` (description) and `hours-api/src/openapi/registry.ts`. `/openapi.json` and `/docs` are mounted above the session guard.
- **Evidence.** The scope name and the allowed `sub` `system:meetings-api` are now public. Sibling services document their system routes the same way, and the route is guarded.
- **Fix.** None required. Optionally drop the `sub` from the public description.

### I6: INFO: A02/A09 Retention: new rows keep user and meeting ids with no erasure path

- **Files:** `hours-api/prisma/migrations/20261124093525_meeting_hours/migration.sql`; decisions.md T6 notes that blocks of a deleted meeting remain.
- **Evidence.** `meeting_hours_block` (meetingId, userId, reason) and `meeting_hours_meeting` (meetingId, seq) have no FK and are never cleaned, the same posture as `time_entry`.
- **Fix** (optional). Blocks can be dropped when a meeting is gone, because the `meeting_hours_meeting` row (the version guard) must stay so a stale lower version is still ignored:
  ```ts
  if (facts === null) await tx.meetingHoursBlock.deleteMany({ where: { meetingId } }); // apply.ts, before step 7
  ```

### I7: INFO: the T7 Prisma error-logging note: pre-existing, not introduced, no leak observed

- **Origin.** `log: [...["error"]]` is at `hours-api/src/lib/db.ts:16`. It came in with the initial time-tracking commit `2b3d2fef` and is unchanged on this branch.
- **Probes.** A scratch database migrated with this branch's migrations, `NODE_ENV=production`, canary values in `userId`, `meetingId` and `note`:

  | Failure | What Prisma wrote to stderr |
  |---|---|
  | `time_entry_follows_shape` CHECK violation | `Database error. Code: 23514. Message: new row for relation "time_entry" violates check constraint "time_entry_follows_shape"` |
  | Unique index `(userId, sourceMeetingId)` | `Unique constraint failed on the fields: ("userId", "sourceMeetingId")` |
  | NUL byte in an id, through the route | `invalid byte sequence for encoding "UTF8": 0x00` |
  | Client-side validation error (invalid `Date`) | thrown but not logged by Prisma |

  - None of them printed a row value or a canary. The driver adapter reports only the Postgres message, not `DETAIL "Failing row contains (...)"`.
  - In development mode Prisma adds a code frame of source text, not runtime values.
  - The app's own `handleError` logs name and code only (`hours-api/src/lib/errors.ts`).
- **Does the feature add exposure?** No new raw query casts a user value. `apply.ts` and `record.ts` use text parameters and a boolean cast, and the new failure paths (CHECK, unique, deadlock) name constraints only. The residual class is a Postgres message that echoes a value, such as a type-cast error on a raw query, and nothing here can produce one.
- **Fix.** None for T13. Optional, repo-wide: log by event with the target only.
  ```ts
  new PrismaClient({ adapter, log: [{ emit: "event", level: "error" }] });
  db.$on("error", (e) => console.error("[prisma]", { target: e.target }));
  ```

### I8: INFO: design G6, the mark in Everyone's hours on an entry its person moved: ACCEPTED

- **Evidence.** `EntriesTable.tsx:68` shows the mark for `origin === 'meeting'` whatever the entry is on now.
  - Only `time-entry:read-all` holders (admin by seed) see it, and they already see every entry of everyone. For an unmoved entry the mark adds no new fact.
  - For a moved entry the provenance is the only bit disclosed: no meeting id, title, participants or content (`sourceMeetingId` and `followsMeeting` are never in the view). The day and minutes may have been changed, so the inference is weaker than G6 states.
  - The existing time-tracking precedent already shows read-all holders a "Meeting, not visible to you" entry with its person, day and duration.
- **Decision.** Recorded as accepted, consistent with D62 and AC-2.3.
- **Fix.** None. If the owner prefers the stricter reading, change `EntriesTable.tsx:68` only: `const automatic = entry.origin === 'meeting' && entry.on.type === 'meeting'`.

## Checked and clean

- **A06/A08.** No dependency, lockfile or package manifest changes, and no deserialization of untrusted data.
- **A10.** `HOURS_API_URL` is operator configuration only. The path is a constant, and the fetch uses `redirect: "error"` with a 5 s timeout, so a redirect cannot carry the bearer elsewhere.
- **A02.** No secrets in the diff: `auth/.env.example` and the env-doctor templates carry placeholders and `${{shared...}}` references only.
- **Test hooks.** `setHoursChannelForTests` and `__setDefaultJwksForTests` are in-process only, and the channel is `null` under `NODE_ENV=test`. Nothing production imports `test-support` or `fakeHours`.
- **hours-ui.** All new copy is rendered as React text with no HTML sink, and the strings exist in en and it. Meeting titles reaching the XLSX export are plain string cells, so they are never a formula (`hoursWorkbook.ts`).

## Outside this review's scope

- **Labour-law sign-off.** Spec O3 (IT art. 4 L. 300/1970, CH art. 26 OLL 3) is a go-live sign-off by management / HR, accepted as risk by the owner. It is not a code finding and is unchanged.
- **Deploy order.** Add `meeting-hours-notices.send` to production `SERVICE_CLIENTS` only after the auth that knows it is live (infra and deploy-order matters in T12).
- **Not reviewed.** T11 (e2e spec) and T12 (docs and runbook) are not written yet.

## Review environment (not a finding)

I created three scratch databases in the local compose Postgres (`localhost:5435`): `hours_probe_scratch`, `hours_owasp_review_test` and `meetings_owasp_review_test`. The cleanup `DROP DATABASE` was blocked by the workspace's pre-bash guard, and I did not bypass it. They can be dropped manually. The shared `hours_test` and the dev databases were not touched. My throwaway probe files are in the session scratchpad, outside the repo.

## Summary

0 critical · 0 high · 0 medium · 1 low · 8 info

## Delta review 2026-11-24 — the security-review additions (T18)

**Verdict: PASS.** 0 critical · 0 high · 0 medium · 0 low · 3 info.

- **Scope.** `git diff ef89ef43..0ae2af50`, docs and specs excluded (commits 4bcddbed T15 and 33822e97 T16). It covers three areas:
  - `prepare_audio`'s measured duration: `meetings-api/src/media/measuredDuration.ts` and the step-3 commit and log line in `src/jobs/handlers/prepareAudio.ts`.
  - hours-ui's mark predicate: `src/lib/fromMeetingMark.ts` and its callers `EntryRow.tsx`, `EntriesTable.tsx` and `DeleteEntryDialog.tsx`.
  - hours-api `src/entries/entries.routes.ts`.
- **Method.** Read-only and static. The test assertions that bear on a question were read, not re-run.
- **Stack.** Bun + Hono + Prisma and React, so JPA and jOOQ checks do not apply.
- **No manifest, lockfile, migration, env or outbound-call change in the diff.** A06, A05 and A10 have nothing new to check.

### Accepted risk, not re-raised

Review notes **I1, I3 and I6** are accepted as risk by the owner (ledger D74, D75, D76: `specs/20261112-time-tracking/ledger.md:132-134`). Their code is untouched by this diff and none of them is re-raised here.

### The T18 questions

**1. Does the correction close L1 as plan § Security claims?** It closes L1 for readable audio, and the claim is stated accurately.
- **What changed.** Step 3 now reads the held duration under the meeting's row lock, calls `durationAfterMeasure(held, measuredMs)` and writes `durationMs` only when the result differs (`prepareAudio.ts:268-270, :278`). The rule replaces the held value when `difference > 30 s && difference × 10 > held`, in either direction, with integers only (`measuredDuration.ts:27-30`).
- **Source of the measured figure.** It is `format.duration` of the Ogg that ffmpeg re-encoded (`normalize.ts:197-203`), so the creator's container claim and the browser's per-chunk reports no longer decide an entry for readable audio.
- **Plan's wording.** § Security says "no longer stands against readable audio", which is what the code does. It does not claim to close the unreadable case.

**2. What stays creator-trusted?** Exactly the three the plan names, plus the failure sub-cases it folds into the third. All are bounded; see Q4.
- **The window between Stop and the end of `prepare_audio`.** Entries are built from the held duration at Stop. The correction can only land in the step-3 commit.
- **Differences inside the margin.** The held duration stands when the difference is at most 30 s or at most 10 % of held. The margin is at most 18.1 min (10 % of 181 min), which is less than one 30-minute step (`desired.ts:31`). So a held 3 h 01 min against a real 2 h 43 min leaves a 180-minute entry where the audio alone would give 150. The overstatement is at most one step.
- **Audio that cannot be measured (D69).** The L1 example, about 722 one-byte chunks reported at 15 s each, still ends as follows:
  - the local probe is not ok, so `NormalizeError("audio_unreadable")` (`prepareAudio.ts:254`);
  - the meeting is marked failed and the job is permanent (`:314-315`);
  - there is no commit, so the held 3 h and the 180-minute entries stand.
  - `too_long` on a recording and a transient failure that exhausts its retries (`:318`) behave the same way. A creator's retry resumes at `prepare_audio` and corrects then.
  - An upload that decodes past 3 h still goes back to `draft` with a null duration and a notice (`:305`), as before.

**3. Does the log line leak anything personal?** No.
- The line is `console.log("[prepare_audio] duration_corrected", { meetingId, heldMs, measuredMs })` (`prepareAudio.ts:293`).
- It carries an opaque cuid and two integers, no user id and no title. The values are not free text, so there is no log-injection path.
- It fires after the commit and only when `held !== null && next !== held` (`:285`), so a filled null duration logs nothing.
- `prepareAudio.measured.test.ts:208-218` asserts that neither the creator id nor the title appears in any logged call.

**4. Can a creator still force an entry beyond the plan's bound (180 min per person and meeting)?** No.
- The result is always the held or the measured duration, so it is at most the larger of the two caps.
  - Held is at most `MAX_RECORDING_MS` = 3 h 01 min for a recording (`recording.routes.ts:33, :269`) and at most `MAX_AUDIO_MS` = 3 h for an upload (`probe.ts:34`, the probe's `too_long` reject at `:227`).
  - Measured is at most `MAX_NORMALIZED_MS` = 3 h 01 min (`normalize.ts:34`). Anything above is `too_long` (`:197`, and `:202` via `MAX_OUTPUT_SECONDS`).
- 3 h 01 min rounds to 180 min (`desired.ts:31`: `floor((ms + 15 min) / 30 min) × 30`).
- No other writer of `meeting.durationMs` can act on a `processing` meeting:
  - `text.routes.ts:82` writes null on create.
  - `upload.routes.ts:190` and `recording.routes.ts:391` run at the draft-to-processing transition.
  - `recording.routes.ts:467` is the recording-to-draft abort.
  - The PATCH route in `core.routes.ts` accepts no duration.

**5. Does the row-lock read keep the decision safe against a concurrent write?** Yes.
- `readHoursFacts` runs `SELECT … FOR UPDATE` on the meeting row, then reads `durationMs` in a separate statement (`record.ts:62-70`). `ctx.commit` sets no isolation level (`runner.ts:286-294`), so it is the database default, READ COMMITTED. A writer that committed before the lock was granted is therefore seen.
- The lock is held through `updateMany`, `recordHoursNotice` (which locks again and bumps `hoursSeq`) and `enqueueJob`.
- The write is guarded by `status: "processing", audioKey: null` (`prepareAudio.ts:273`).
  - A deleted meeting gives `held = null` and `updateMany` count 0, so nothing is written and the audio object is deleted (`:281`, `:287-291`).
  - A lost lease gives `committed: false` (`runner.ts:292`).
- Retrying after a crash is idempotent, because `audioKey !== null` returns early (`:221-225`) and the correction is not applied twice.
- `prepareAudio.measured.test.ts:232-243` kills the stale-copy variant: a duration written while ffmpeg runs is the one decided against.
- The lock order is job row, then meeting row. That order is unchanged from before this diff, and Postgres resolves a delete-versus-commit deadlock by aborting one transaction, which the handler retries as transient.

**6. Does the hours-ui predicate leave any path where a moved entry reveals its meeting?** No, by the UI.
- `showsFromMeetingMark` is `origin === 'meeting' && on?.type === 'meeting'` (`fromMeetingMark.ts:17-18`). It is the only mark reader, called from `EntryRow.tsx:100` and `EntriesTable.tsx:71, :86`. No other source file reads `origin`: not the export, the cell dialog or `EntryDialog`.
- A moved entry draws the kind badge alone. The mark also needs `on.type === 'meeting'`, so no id or title can come through it, and the view carries neither `sourceMeetingId` nor `followsMeeting` (`hours-api/src/entries/view.ts:80-83`).
- A hidden or deleted meeting keeps the mark with the placeholder name. That discloses only what Everyone's hours already did and what I8 accepted.
- `fromMeetingMark.test.ts` pins the U table, including a move off and back, hidden or unavailable names, `person`, a missing `origin` and a missing `on`.
- See N3 for the one residual, which is in the wire and not in the UI.

**7. Does the delete sentence still key on `origin` alone (D70), and does it leak anything?** Yes and no.
- `DeleteEntryDialog.tsx:91` reads `entry.origin === 'meeting'` and nothing else.
- The text is a constant string (`strings/entry.ts:138`) with no entry data.
- The dialog is mounted only from `MyHoursPage.tsx:757`, over the person's own entries. Everyone's hours (`EntriesTable`) has no delete.
- `DeleteEntryDialog.test.tsx` pins it for a project, a deal and other work.

**8. hours-api `entries.routes.ts`: comment-only?** Yes. The hours-api diff outside tests is one line, a `//` comment at `:371`. `followsMeeting: false` at `:372` and everything around it are unchanged, and no other hours-api source file changed.

### Findings

None at critical, high, medium or low. Three info notes need no action for PASS.

**N1 — INFO, A04: the residual of L1 is as the plan states it and stays within 180 minutes.** The cases are in Q2 (`measuredDuration.ts:29-30`, `prepareAudio.ts:254, :314-318`). The effect is at most 180 min × 31 people per meeting, which is the accepted creator-trust model (AC-1.7, D54-D57, D69). Nothing to fix.

**N2 — INFO, A04, not verified: whether a crafted container can inflate the measured figure.**
- The measured figure is the Ogg that ffmpeg wrote, not a count of decoded samples. The arguments at `normalize.ts:127-137` do no timestamp normalisation.
- No test feeds a readable input with a jump or gap in container timestamps (nothing of the kind in `normalize*.test.ts` or `prepareAudio*.test.ts`).
- I could not run ffmpeg under the read-only rule, so I did not check whether such an input can make the output claim more than the real audio.
- The 3 h 01 min cap (`normalize.ts:197, :202`) holds either way, so the 180-minute bound is unaffected. What would be weaker is the plan's sentence "a claimed duration no longer stands against readable audio".
- Suggested check, cheap and not blocking: in `normalize.real.test.ts` style, build a two-packet container with a 3 h timestamp jump, run it through the real `normalizeAudio`, and read `durationMs`. If it is seconds, record it as checked. If it is about 3 h, add the case to § Security as one more creator input within the same bound.

**N3 — INFO, A01/A04: `origin` is still on the wire for a moved entry.**
- `hours-api/src/entries/view.ts:83, :181` send `origin: row.origin` for every entry, including to a `time-entry:read-all` holder on a moved one (D70 needs it for the owner's delete sentence).
- hours-ui no longer renders it for a moved entry, so the UI path I8 named is closed. A holder reading the JSON still learns the provenance bit: the entry began as an automatic meeting entry. I8 had already judged that bit acceptable on screen, so this is no new exposure.
- Plan § Security says it is "shown to its person only". That is true of the UI and not of the JSON, so I suggest the sentence say so.
- Optional hardening, not needed for PASS: `toView` already has `own` (`view.ts:166`). It could send `origin: own || row.on is a meeting ? row.origin : "person"`. That changes the "origin never changes" contract for non-owner views only, so weigh it against the OpenAPI text at `entries.routes.ts:123`.

### Checked and clean

- **A03.** No new raw SQL in the diff. `readHoursFacts` is the existing tagged template with a bound `meetingId`.
- **A02/A09.** Covered in Q3. No secret or personal value in logs, tests or fixtures. The tests use a fixed creator id and title as canaries.
- **A06/A08.** No dependency or deserialization change.
- **A10.** No new outbound call. The measured figure is the value ffprobe already returned, so no new reader of bytes (plan § Security's last bullet holds).
- **hours-ui.** The new code is a pure boolean over two fields, with no HTML sink, no new string and no new route. The type comment in `hoursApi.types.ts` changed only.

### Summary

0 critical · 0 high · 0 medium · 0 low · 3 info. Accepted by the owner and not re-raised: I1, I3 and I6 (D74-D76).
