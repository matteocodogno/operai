---
spec: 021
generated: 2026-11-04
synced: 2026-11-05
---

# Tasks: Meetings — record, transcribe, summarise and question meetings

Contracts are `plan.md` (approved 2026-11-04, amended at the design stage G1–G9). Screens,
states and copy are `design.md`. Domain prefixes:
- `[BE]` = backend-dev (meetings-api, auth, crm-api, notify-api);
- `[FE]` = frontend-dev (meetings-ui, shell, crm-ui, notify-ui, operai-ui);
- `[OPS]` = devops (files only, no real provisioning);
- `[QE]` = e2e and eval fixtures.

Real providers (Azure Speech, Bedrock) are never called by a test: tests use the fakes from
T31/T35. FE tasks test against `src/test-support/fakeApi.ts` (crm-ui style) and the plan's
contracts, not a running API. "On `meetings_test`" means `DATABASE_URL` points at the test
database after `bun run db:deploy`.

- [x] T1: [OPS] Local MinIO bucket `meetings` with a 29-day expiration rule and versioning off — refs: AC-4.4 — deps: none
  - touch: `compose.yaml`
  - done when: `docker compose up -d minio minio-createbucket` exits 0, and `mc ilm rule ls <alias>/meetings` (run in the createbucket image) lists exactly one rule, Expiration 29 days, no prefix filter; `mc version info <alias>/meetings` reports versioning not enabled

- [x] T2: [BE] auth: `meetings` catalog, seed grants (`employee` → `meetings:access`; `admin` → `template:manage`, `meeting:erase`), `meetings` in `ALL_APP_IDS`, and a test that no two catalogs declare the same resource key — refs: AC-10.8, AC-1.4, AC-10.5 — deps: none
  - touch: `auth/src/authz/catalogs/meetings.ts`, `auth/src/authz/catalogs/meetings.test.ts`, `auth/src/authz/catalogs/uniqueResourceKeys.test.ts`, `auth/src/authz/seed.ts`, `auth/src/authz/seed.test.ts`
  - done when: `cd auth && bun test src/authz/catalogs src/authz/seed.test.ts` passes, including "employee holds meetings:access", "template:manage / meeting:erase only on admin", "no other rule mentions them" and "duplicate resource key fails"

- [x] T3: [BE] auth: service scope `host-notices.send` accepted in `SERVICE_CLIENTS`; documented client `meetings-api` = `notifications.push host-notices.send` — refs: AC-11.8, AC-12.4 — deps: none
  - touch: `auth/src/system/serviceClients.ts`, `auth/src/system/serviceClients*.test.ts`
  - done when: `cd auth && bun test src/system` passes; a new test mints a token for a client with `host-notices.send` and rejects an unknown scope; a test asserts the documented `meetings-api` entry has no `emails.send`

- [x] T4: [BE] auth: add `meetings:access` to `DIRECTORY_GATE_PERMISSIONS` (ADR-0066) — refs: AC-5.1 — deps: none
  - touch: `auth/src/authz/directory.routes.ts`, `auth/src/authz/directory.routes.test.ts`
  - done when: `cd auth && bun test src/authz/directory.routes.test.ts` passes with a new case: a caller holding only `meetings:access` gets 200 and the unfiltered list

- [x] T5: [BE] notify-api: origin `meetings` + binding `system:meetings-api → ["meetings"]`; optional `it: {title, body}` on `/system/notifications`, stored as `titleIt`/`bodyIt` and returned by the list and SSE payloads (ADR-0065) — refs: AC-12.5, AC-12.1 — deps: none
  - touch: `notify-api/prisma/schema.prisma`, `notify-api/prisma/migrations/*`, `notify-api/src/notifications/notifications.schemas.ts`, `notify-api/src/notifications/notifications.repo.ts`, `notify-api/src/notifications/list.routes.ts`, `notify-api/src/notifications/*.test.ts`, `notify-api/src/system/notifications.schemas.ts`, `notify-api/src/system/notifications.routes.ts`, `notify-api/src/system/systemAuth.middleware.ts`, `notify-api/src/system/*.test.ts`
  - done when: `cd notify-api && bun run db:deploy && bun test` passes; new cases cover the `it` variant round-trip (`POST` → list → SSE), the length limits, and `system:meetings-api` refused for `originApp: "crm"`

- [x] T6: [BE] crm-api: `systemAuth` middleware for service JWTs (aud `SERVICE_AUDIENCE`, scope, sub allowlist) and `SERVICE_AUDIENCE` env (copied from notify-api) — refs: AC-11.8 — deps: none
  - touch: `crm-api/src/auth/systemAuth.middleware.ts`, `crm-api/src/auth/systemAuth.middleware.test.ts`, `crm-api/src/lib/env.ts`
  - done when: `cd crm-api && bun test src/auth/systemAuth.middleware.test.ts` passes: identical 401 for user JWT / wrong aud / missing scope / unlisted sub; accepted call logs `caller=<sub>` only

- [x] T7: [BE] crm-api: `POST /meeting-host/v1/resolve` (caller's JWT, live resolve fail closed, `open|closed|missing`, `hostVisible` = `deal:financials`, ≤ 25 ids) — refs: AC-1.5, AC-5.6, AC-5.7, AC-11.5 — deps: none
  - touch: `crm-api/src/meeting-host/resolve.routes.ts`, `crm-api/src/meeting-host/resolve.test.ts`, `crm-api/src/index.ts`, `crm-api/src/matrix.test.ts`
  - done when: `cd crm-api && bun test src/meeting-host/resolve.test.ts src/matrix.test.ts` passes on `crm_test`: no `crm:access` → `closed`/`missing`; holder → `open` + title + href; financials on/off → `hostVisible`; auth outage → 503; 26 ids → 422

- [x] T8: [BE] crm-api: migration (`activity.meetingId` unique + CHECK type=meeting, `meeting_host_state`) and `POST /system/meeting-host/v1/notices` reconciler (linked upsert/move, changed, unlinked, deleted, seq guard, strict body) — refs: AC-14.1, AC-14.2, AC-14.3, AC-14.5, AC-14.6, AC-14.7, AC-14.9 — deps: T6, T7
  - touch: `crm-api/prisma/schema.prisma`, `crm-api/prisma/migrations/*`, `crm-api/src/meeting-host/notices.routes.ts`, `crm-api/src/meeting-host/notices.test.ts`, `crm-api/src/index.ts`, `crm-api/src/matrix.test.ts`
  - done when: `cd crm-api && bun run db:deploy && bun test src/meeting-host src/matrix.test.ts` passes on `crm_test`, covering:
    - one activity per meeting across duplicates and retries;
    - relink moves the activity to the new deal's company;
    - an out-of-order seq is ignored;
    - `changed` never recreates a hand-deleted activity;
    - an extra body key → 422;
    - missing deal → 422 `entity_not_found`;
    - author = `creatorId` and the author-only edit rule still applies

- [x] T9: [BE] crm-api: activity view field `meeting: { id, href: "/my-meetings/m/<id>" } | null`, body null for meeting activities — refs: AC-14.2, AC-14.4 — deps: T8
  - touch: `crm-api/src/activities/activities.routes.ts`, `crm-api/src/activities/activities.test.ts`
  - done when: `cd crm-api && bun test src/activities` passes with a case asserting the view of a notice-created activity (subject, occurredAt, `body: null`, `meeting.href`) on both the deal and the company timeline

- [x] T10: [BE] meetings-api scaffold: Bun + Hono + zod-openapi, Prisma config, Dockerfile with pinned ffmpeg/ffprobe and a non-root user, `railway.json` (`numReplicas: 1`), health, Problem JSON, path-only request logger, minimal `env.ts`, and stub routers registered in `src/index.ts` for every route group of the plan — refs: AC-4.10 — deps: none
  - touch: `meetings-api/package.json`, `meetings-api/bun.lock`, `meetings-api/bunfig.toml`, `meetings-api/tsconfig.json`, `meetings-api/prisma.config.ts`, `meetings-api/Dockerfile`, `meetings-api/railway.json`, `meetings-api/README.md`, `meetings-api/src/index.ts`, `meetings-api/src/health/*`, `meetings-api/src/openapi/*`, `meetings-api/src/lib/problem.ts`, `meetings-api/src/lib/logger.ts`, `meetings-api/src/lib/logger.test.ts`, `meetings-api/src/lib/db.ts`, `meetings-api/src/lib/http.ts`, `meetings-api/src/lib/env.ts`, `meetings-api/src/{meetings,hosts,capture,processing,transcript,audio,summaries,templates,conversation,erase}/*.routes.ts`
  - done when: `cd meetings-api && bun install && bun run typecheck && bun test src/lib/logger.test.ts src/health` passes; the logger test asserts query strings and bodies are absent from the log line; `docker build meetings-api` succeeds and `ffmpeg -version` runs as the non-root user in the image

- [x] T11: [BE] meetings-api env + synchronous residency checks: full env schema of the plan; S3 EU residency (copied `s3Residency`); Azure region allowlist + endpoint match; Bedrock region allowlist; `MEETINGS_TEST_HOSTS` and `MEETINGS_AI_PROVIDER=fake` refused in production — refs: AC-4.9, AC-11.1 — deps: T10
  - superseded 2026-11-05 (provider change), by T95 (Azure/Bedrock parts)
  - touch: `meetings-api/src/lib/env.ts`, `meetings-api/src/lib/env*.test.ts`, `meetings-api/src/lib/s3Residency.ts`, `meetings-api/src/lib/residency.ts`, `meetings-api/src/lib/residency.test.ts`
  - done when: `cd meetings-api && bun test src/lib/env src/lib/residency.test.ts` passes. Each misconfiguration (non-EU S3, Azure region outside EU/CH, endpoint/region mismatch, `eu-west-2`/`us-east-1` Bedrock, test hosts or fake provider with `NODE_ENV=production`) makes a spawned `bun src/lib/env.ts` exit 1 without echoing values

- [x] T12: [BE] meetings-api Prisma schema and initial migration: every model of plan § Data model, all-or-none CHECKs, partial unique indexes (live session, template names), Tier-1 append-only trigger on `meeting_deletion` — refs: AC-4.6, AC-5.1, AC-3.5, AC-7.3 — deps: T10
  - touch: `meetings-api/prisma/schema.prisma`, `meetings-api/prisma/migrations/*`, `meetings-api/src/lib/generated/**`, `meetings-api/src/schema.test.ts`
  - done when: `cd meetings-api && bun run db:deploy && bun test src/schema.test.ts` passes on `meetings_test`, proving:
    - each CHECK rejects its invalid row (host all-or-none, hostVisible without host, consent all-or-none, consent on a `text` meeting, participant kind xor);
    - a second live session and a duplicate personal/shared name are rejected;
    - UPDATE/DELETE on `meeting_deletion` raise;
    - `meeting_deletion` has no title column

- [x] T13: [BE] meetings-api guard stacks (`selfScoped` with optional resolve, `capability(…)`, `eraser`), JWT + authz middleware (copied from crm-api), identities client (names fail soft, gates fail closed), `test-support/testAuth.ts` — refs: AC-10.6, AC-1.4, AC-5.10 — deps: T11
  - touch: `meetings-api/src/auth/*`, `meetings-api/src/authz/*`, `meetings-api/src/lib/identities.ts`, `meetings-api/src/lib/identities.test.ts`, `meetings-api/src/test-support/testAuth.ts`
  - done when: `cd meetings-api && bun test src/auth src/authz src/lib/identities.test.ts` passes:
    - with `/authz/resolve` stubbed to 503, `selfScoped` lets the request through with `capabilities: "unavailable"` and `capability` answers 503;
    - an identities outage gives `PersonRef.status "unknown"` for display and 503 for a gate;
    - `deleted` maps to name null

- [x] T14: [BE] meetings-api storage: presigned POST (chunk ≤ 8 MiB, upload ≤ 500 MiB + type allowlist, fixed keys), presigned GET (60 s probe, 15 min playback), HEAD, delete-prefix, fake storage; startup bucket check (lifecycle ≤ 29 days with no prefix filter, versioning not enabled) — refs: AC-4.4, AC-4.9, AC-3.2, AC-4.5 — deps: T11
  - touch: `meetings-api/src/lib/storage.ts`, `meetings-api/src/lib/storage.test.ts`, `meetings-api/src/lib/startupChecks.ts`, `meetings-api/src/lib/startupChecks.test.ts`, `meetings-api/src/test-support/fakeStorage.ts`
  - done when: `cd meetings-api && bun test src/lib/storage.test.ts src/lib/startupChecks.test.ts` passes. Policy conditions are asserted on the minted POST. Against local MinIO (T1 bucket) the startup check passes, and it fails for a bucket with no rule, with `Days: 30`, with a prefix-filtered rule, and with versioning enabled

- [x] T15: [BE] meetings-api host registry (production = exactly `crm/deal` with labels incl. `visibilityHint`/`noticeFailed`; `MEETINGS_TEST_HOSTS`), the single HTTP host client (`resolve` batch ≤ 25, 2 s timeout, unavailable on any defect; `notices`), and `test-support/fakeHost.ts` (Bun.serve; `testhost/widget` notices on, `quiethost/gadget` notices off) — refs: AC-11.1, AC-11.4, AC-11.10 — deps: T11
  - touch: `meetings-api/src/hosts/registry.ts`, `meetings-api/src/hosts/registry.test.ts`, `meetings-api/src/hosts/client.ts`, `meetings-api/src/hosts/client.test.ts`, `meetings-api/src/test-support/fakeHost.ts`
  - done when: `cd meetings-api && bun test src/hosts/registry.test.ts src/hosts/client.test.ts` passes: registry contents asserted; the client maps 5xx / timeout / malformed body to `unavailable`; the client module exports only `resolve` and `sendNotice` (static assertion)

- [x] T16: [BE] meetings-api service-token client (copy) and notifier: in-app only, never `email: true`, bilingual `title/body` + `it` from a copy catalog (en/it parity), best effort after commit — refs: AC-12.3, AC-12.4, AC-12.5 — deps: T11
  - touch: `meetings-api/src/lib/serviceToken.ts`, `meetings-api/src/lib/notify.ts`, `meetings-api/src/lib/notify.test.ts`, `meetings-api/src/lib/notificationCopy.ts`, `meetings-api/src/lib/notificationCopy.test.ts`
  - done when: `cd meetings-api && bun test src/lib/notify.test.ts src/lib/notificationCopy.test.ts` passes:
    - catalog parity;
    - payload keys allowlisted (no content keys) and `email` never set;
    - a throwing or 500 notify-api never rejects;
    - one 401 retries once with a fresh token

- [x] T17: [BE] meetings-api durable job runner: `LISTEN/NOTIFY` wake + 30 s idle poll of its own queue, `FOR UPDATE SKIP LOCKED` claim incl. expired leases, 2 min lease heartbeated, ≤ 2 concurrent (one ffmpeg), 3 attempts with backoff, `attemptId` guard, SIGTERM drain; stub handler files per job kind (ADR-0062) — refs: AC-6.9, AC-7.9 — deps: T12
  - touch: `meetings-api/src/jobs/runner.ts`, `meetings-api/src/jobs/runner.test.ts`, `meetings-api/src/jobs/handlers/*.ts`
  - done when: `cd meetings-api && bun test src/jobs/runner.test.ts` passes on `meetings_test`, covering:
    - a crashed lease is re-claimed;
    - two runners never run the same job;
    - transient errors retried 3× then `failed`, permanent errors fail at once;
    - a stale `attemptId` result is discarded;
    - no code path in the runner reads a lifecycle timestamp to change a meeting's status (static check)

- [x] T18: [BE] meetings-api visibility and frozen derivation: creator / Operai participant / host reader (live `meetings:access` + host resolve, no cache), identical 404 for not-visible, frozen from the creator's live identity (soft for display, closed for gates) — refs: AC-5.2, AC-5.3, AC-5.7, AC-5.11, AC-5.13, AC-4.8 — deps: T12, T13, T15
  - touch: `meetings-api/src/meetings/visibility.ts`, `meetings-api/src/meetings/visibility.test.ts`
  - done when: `cd meetings-api && bun test src/meetings/visibility.test.ts` passes:
    - matrix of creator, participant, host reader (with/without `meetings:access` / host `hostVisible` / `closed`), admin outsider and erase holder;
    - frozen on identities `deleted` and back on `active`;
    - identities outage → `frozen: null` for display and a 503 from the gate helper

- [x] T93: [BE] meetings-api `Meeting` view builder and derived state: status incl. `interrupted` (no audio or beat for 2 min), audio state (`until` = `audioCreatedAt` + 29 d), `recording.lostMs`, every `can` flag incl. `changeSource` / `changeLanguage`, `capabilities` — refs: AC-2.8, AC-2.9, AC-4.4, AC-5.8, AC-5.11, AC-10.6 — deps: T18
  - touch: `meetings-api/src/meetings/view.ts`, `meetings-api/src/meetings/view.test.ts`, `meetings-api/src/meetings/derived.ts`, `meetings-api/src/meetings/derived.test.ts`
  - done when: `cd meetings-api && bun test src/meetings/view.test.ts src/meetings/derived.test.ts` passes:
    - with an injected clock: 2 min with no chunk or beat → `interrupted`, and a paused session with beats stays `recording`;
    - `lostMs` vectors, including null and the floor at 0;
    - audio `kept` / `deleted` at the boundary;
    - `can` truth table per role, frozen state and `capabilities` value

- [x] T19: [BE] meetings-api `POST /meetings`, `GET /meetings/:id`, `PATCH /meetings/:id` for metadata/language/source (lock only on audio/chunk/text; switching to `text` clears consent, G1). A host reference on create is resolved as the caller and emits a `linked` notice through T20 — refs: AC-1.1, AC-1.2, AC-1.3, AC-1.4, AC-1.5, AC-1.6, AC-1.8, AC-2.3, AC-3.5, AC-11.6 — deps: T93, T20
  - touch: `meetings-api/src/meetings/core.routes.ts`, `meetings-api/src/meetings/core.test.ts`
  - done when: `cd meetings-api && bun test src/meetings/core.test.ts` passes on `meetings_test` with the fake host, covering:
    - each invalid field → 422 naming it, no row; default `startsAt`;
    - no capability → 403;
    - fake host `missing` vs `closed` → byte-identical 422 `host_entity_not_found`; unregistered → 422 `host_not_registered`; host 503 → 503 `host_unavailable`, while standalone still gets 201;
    - `language_locked` after processing starts;
    - `source_locked` only once audio, a chunk or text exists; switching to `uploaded` keeps consent and to `text` clears it

- [x] T20: [BE] meetings-api host-notice outbox: written in the change's transaction with per-meeting `seq`, one awaited attempt after commit (5 s), manual policy for linked/changed (failure surfaced on the view), until-delivered handler for unlinked/deleted (backoff schedule), `POST /meetings/:id/host-notice/retry`, delivered rows removed, null title on unlinked/deleted, no notice for frozen meetings or non-opted-in hosts — refs: AC-11.8, AC-11.9, AC-14.6, AC-14.8, AC-14.10, AC-14.11 — deps: T15, T17, T18
  - touch: `meetings-api/src/hosts/notices.ts`, `meetings-api/src/hosts/notices.test.ts`, `meetings-api/src/hosts/noticeRetry.routes.ts`, `meetings-api/src/jobs/handlers/deliverHostNotice.ts`
  - done when: `cd meetings-api && bun test src/hosts/notices.test.ts` passes with the fake host, covering:
    - a 500 on `linked` leaves the action 2xx with `hostNotice.state=failed`, no retry job, and the retry route delivering it;
    - `deleted` failing 3× is delivered by the retry jobs;
    - `quiethost` and standalone meetings get zero calls;
    - frozen → retry route 403 `frozen`;
    - payload keys equal the allowlist

- [x] T21: [BE] meetings-api host routes: `GET /hosts` (public registry part incl. `visibilityHint`, `noticeFailed`), `GET /hosts/:app/:type/:id`, `GET /hosts/:app/:type/:id/meetings` (only what the viewer may open, no hidden counts, `hostReadersUnavailable`), `GET /hosts/:app/:type/:id/linkable-meetings` (own creator meetings, not frozen, not on this entity; G2) — refs: AC-1.1, AC-1.7, AC-5.5, AC-5.6, AC-11.2, AC-11.3, AC-11.4 — deps: T93
  - touch: `meetings-api/src/hosts/hosts.routes.ts`, `meetings-api/src/hosts/hosts.routes.test.ts`
  - done when: `cd meetings-api && bun test src/hosts/hosts.routes.test.ts` passes with `testhost` and `crm`-shaped fake hosts, covering:
    - list contents per viewer class, with `hostVisible:false` excluded;
    - no field reveals hidden meetings;
    - the linkable list excludes participant-only, frozen and already-linked meetings;
    - the entity GET returns the host title

- [x] T22: [BE] meetings-api `PATCH /meetings/:id` host link / relink / unlink and `hostVisible` (re-resolve as creator, 422 `host_visible_unavailable`), plus `changed` notices on title/date-time change — refs: AC-1.7, AC-5.5, AC-5.6, AC-5.7, AC-11.8, AC-14.5, AC-14.7 — deps: T19, T21
  - touch: `meetings-api/src/meetings/core.routes.ts`, `meetings-api/src/meetings/hostLink.test.ts`
  - done when: `cd meetings-api && bun test src/meetings/hostLink.test.ts` passes. The fake host records exactly linked / changed (title) / changed (date) / unlinked(old) + linked(new) / unlinked for the matching PATCHes, and nothing for a format-only change. A closed target is refused. Host readers of the old entity get 404 and of the new one 200 on the next request. Standalone or non-offering host → 422

- [x] T23: [BE] meetings-api `GET /meetings` (My meetings): creator or Operai participant only, filters (q, role, status incl. derived `interrupted`, hostApp), 25 per page, newest first, batched host labels (fail soft) — refs: AC-10.1, AC-10.2, AC-10.3, AC-11.5 — deps: T93
  - touch: `meetings-api/src/meetings/list.routes.ts`, `meetings-api/src/meetings/list.test.ts`
  - done when: `cd meetings-api && bun test src/meetings/list.test.ts` passes:
    - an admin sees only their own meetings;
    - each filter alone and combined returns exactly the matching set;
    - with a clock, `status=interrupted` matches the derived rows;
    - host label states `open` / `closed` / `missing` / `unavailable` come out right, with one resolve call per host per page

- [x] T24: [BE] meetings-api participants (`PUT`, ≤ 30, active-user check fail closed, externals) and consent (`POST`, notice version) routes, plus participant-added notifications — refs: AC-5.1, AC-5.4, AC-5.9, AC-5.10, AC-4.1, AC-4.3, AC-12.1 — deps: T16, T93
  - touch: `meetings-api/src/meetings/participants.routes.ts`, `meetings-api/src/meetings/participants.test.ts`, `meetings-api/src/meetings/consent.routes.ts`, `meetings-api/src/meetings/consent.test.ts`
  - done when: `cd meetings-api && bun test src/meetings/participants.test.ts src/meetings/consent.test.ts` passes, covering:
    - 31 participants → 422;
    - an inactive id → 422 `participant_not_active`; identities down → 503;
    - an added participant opens at once and a removed one gets 404 next;
    - exactly one push per newly added Operai user (not the actor, not externals), with link and en/it copy;
    - consent stores user, time and version, `notice_outdated` → 409, `text` → 422

- [x] T25: [BE] meetings-api `DELETE /meetings/:id` (creator path without capability, `meeting:erase` path), storage prefix first, cascade + `MeetingDeletion` + `deleted` notice; `GET /erase/meetings` returning `{id, title, startsAt, creator}` only — refs: AC-4.6, AC-4.7, AC-4.8, AC-5.12, AC-14.6 — deps: T14, T93, T20
  - touch: `meetings-api/src/meetings/delete.routes.ts`, `meetings-api/src/meetings/delete.test.ts`, `meetings-api/src/erase/erase.routes.ts`, `meetings-api/src/erase/erase.test.ts`
  - done when: `cd meetings-api && bun test src/meetings/delete.test.ts src/erase/erase.test.ts` passes, covering:
    - zero rows for the id in every table afterwards, and the prefix deleted;
    - a storage failure → 503 with nothing deleted;
    - the deletion row has no title;
    - a `deleted` notice with null title;
    - an erase holder deletes a frozen meeting but gets 404 on every content route;
    - erase list keys asserted exactly

- [x] T26: [BE] meetings-api recording start / chunk confirm / upload-url re-mint / heartbeat (`capturedMs`, `paused`), single live session, 3 h + 60 s limit — refs: AC-2.1, AC-2.9, AC-2.11 — deps: T14, T93
  - touch: `meetings-api/src/capture/recording.routes.ts`, `meetings-api/src/capture/recording.start.test.ts`
  - done when: `cd meetings-api && bun test src/capture/recording.start.test.ts` passes, covering:
    - no consent → 409 `consent_required`;
    - a second start while live → 409 `recording_elsewhere`;
    - confirm HEAD-checks and returns the next policy for seq + 1 only;
    - a chunk past 3 h + 60 s → 409 `duration_limit`;
    - heartbeat updates `lastBeatAt` and `capturedMs` (max)

- [x] T27: [BE] meetings-api recording stop (`chunks_missing`), process-what-was-captured, discard (chunks deleted, back to `draft`), enqueue of `prepare_audio` — refs: AC-2.6, AC-2.7, AC-2.8 — deps: T17, T26
  - touch: `meetings-api/src/capture/recording.routes.ts`, `meetings-api/src/capture/recording.stop.test.ts`
  - done when: `cd meetings-api && bun test src/capture/recording.stop.test.ts` passes:
    - a gap → 409 with the missing seqs; complete → `processing` + one job;
    - from derived `interrupted`, process keeps `durationMs` = Σ stored chunk durations (paused time excluded);
    - discard deletes the objects and rows

- [x] T28: [BE] meetings-api upload mint + confirm with synchronous `ffprobe` (demuxer allowlist, protocol whitelist, audio stream, ≤ 3 h, 30 s timeout) and media fixtures — refs: AC-3.1, AC-3.2, AC-3.3 — deps: T14, T93
  - touch: `meetings-api/src/capture/upload.routes.ts`, `meetings-api/src/capture/upload.test.ts`, `meetings-api/src/media/probe.ts`, `meetings-api/src/media/probe.test.ts`, `meetings-api/test-fixtures/media/*`
  - done when: `cd meetings-api && bun test src/media/probe.test.ts src/capture/upload.test.ts` passes:
    - an unsupported type or > 500 MiB → 422 at mint;
    - fixtures with no audio track, duration metadata > 3 h, an HLS playlist and an unknown container → 422 `upload_rejected` with the reason, object deleted, `draft`;
    - a missing object → 409 `upload_incomplete`;
    - a valid mp4 → 202 `processing`

- [x] T29: [BE] meetings-api `PUT /meetings/:id/text` (≤ 200,000 chars) → passages (paragraph split ~1,000 chars, no times or speaker) → `ready` — refs: AC-3.4, AC-6.1 — deps: T93
  - touch: `meetings-api/src/capture/text.routes.ts`, `meetings-api/src/capture/text.test.ts`, `meetings-api/src/transcript/passages.ts`, `meetings-api/src/transcript/passages.test.ts`
  - done when: `cd meetings-api && bun test src/capture/text.test.ts src/transcript/passages.test.ts` passes: 200,000 chars → `ready`; 200,001 → 422; no consent required; passage vectors

- [x] T30: [BE] meetings-api `prepare_audio` job: stream chunks or the original to a temp dir, `ffmpeg -protocol_whitelist file,pipe … -vn -sn -dn -ac 1 -ar 16000 -c:a libopus -b:a 32k`, put `audio.ogg`, set `audioCreatedAt`, delete chunks/original, clean up in `finally`, then enqueue `transcribe` — refs: AC-3.1, AC-2.6, AC-4.4 — deps: T17, T28
  - touch: `meetings-api/src/media/normalize.ts`, `meetings-api/src/media/normalize.test.ts`, `meetings-api/src/jobs/handlers/prepareAudio.ts`, `meetings-api/test-fixtures/media/*`
  - done when: `cd meetings-api && bun test src/media/normalize.test.ts` passes with real ffmpeg on fixtures:
    - Chrome webm and Safari fMP4 chunk sequences, including a paused gap;
    - an mp4 video;
    - output is mono Opus with no video stream, the originals are deleted, the temp dir is empty after success and after a forced failure

- [x] T31: [BE] meetings-api `Transcriber` interface, Azure fast transcription implementation (one locale, diarization `maxSpeakers` clamp), fake transcriber, phrase → segment mapping with speaker labels by first appearance — refs: AC-6.2, AC-6.7, AC-13.2 — deps: T11
  - superseded 2026-11-05 (provider change), by T97
  - touch: `meetings-api/src/ai/transcriber.ts`, `meetings-api/src/ai/azureSpeech.ts`, `meetings-api/src/ai/azureSpeech.test.ts`, `meetings-api/src/ai/fakeTranscriber.ts`, `meetings-api/src/ai/segments.ts`, `meetings-api/src/ai/segments.test.ts`
  - done when: `cd meetings-api && bun test src/ai/azureSpeech.test.ts src/ai/segments.test.ts` passes with a stubbed `fetch`:
    - request locale is `it-IT` / `en-US` only, diarization on;
    - 4xx → permanent error, 5xx/429/timeout → transient;
    - zero phrases → `noSpeech`;
    - label vectors, and one voice → one label

- [x] T32: [BE] meetings-api `transcribe` job (segments in one transaction, `ready` / `noSpeech` / `failed` + code), `POST /meetings/:id/retry` (only while audio kept), requester notifications done/failed — refs: AC-6.7, AC-6.9, AC-6.10, AC-12.2, AC-13.2 — deps: T16, T30, T31
  - touch: `meetings-api/src/jobs/handlers/transcribe.ts`, `meetings-api/src/jobs/handlers/transcribe.test.ts`, `meetings-api/src/processing/retry.routes.ts`, `meetings-api/src/processing/retry.test.ts`
  - done when: `cd meetings-api && bun test src/jobs/handlers/transcribe.test.ts src/processing/retry.test.ts` passes with the fake transcriber:
    - `stage` goes preparing → transcribing;
    - a permanent error → `failed` with no segments;
    - retry works while audio is kept and gives 409 `audio_deleted` after expiry;
    - push to the requester carries title and outcome only

- [x] T33: [BE] meetings-api transcript routes: `GET` (segments + speakers), segment `PATCH` with If-Match (`edited`, version, `transcriptVersion` bump), speaker label `PUT` (participant / text / reset) — refs: AC-6.1, AC-6.2, AC-6.3, AC-6.8 — deps: T93
  - touch: `meetings-api/src/transcript/transcript.routes.ts`, `meetings-api/src/transcript/transcript.test.ts`
  - done when: `cd meetings-api && bun test src/transcript/transcript.test.ts` passes:
    - segments come in time order;
    - no If-Match → 428, stale → 409, success → `edited`;
    - a rename applies to every segment of that key;
    - a non-creator → 403, frozen → 403;
    - no job is enqueued by an edit

- [x] T34: [BE] meetings-api audio routes: `GET /meetings/:id/audio` (15 min GET while kept, lazy idempotent delete on observed expiry) and `DELETE /meetings/:id/audio` — refs: AC-4.4, AC-4.5, AC-6.5 — deps: T14, T93
  - touch: `meetings-api/src/audio/audio.routes.ts`, `meetings-api/src/audio/audio.test.ts`
  - done when: `cd meetings-api && bun test src/audio/audio.test.ts` passes:
    - with a clock at `until` − 1 s → URL; at `until` → 409 `audio_unavailable` and exactly one `DeleteObject`;
    - a frozen meeting behaves the same;
    - DELETE removes the prefix and blocks retry and playback;
    - a storage failure → 503 with nothing changed

- [x] T35: [BE] meetings-api `LanguageModel` interface, Bedrock Converse implementation (forced tool-use schema, 60 s timeout), fake LLM (scriptable hostile outputs), and Bedrock startup checks (inference-profile destinations ⊂ EU/CH allowlist; retention mode `none`, unreadable = refuse) — refs: AC-4.9, AC-7.10 — deps: T14
  - superseded 2026-11-05 (provider change), by T100 and T101
  - touch: `meetings-api/src/ai/languageModel.ts`, `meetings-api/src/ai/bedrock.ts`, `meetings-api/src/ai/bedrock.test.ts`, `meetings-api/src/ai/fakeLanguageModel.ts`, `meetings-api/src/lib/startupChecks.ts`, `meetings-api/src/lib/startupChecks.test.ts`
  - done when: `cd meetings-api && bun test src/ai/bedrock.test.ts src/lib/startupChecks.test.ts` passes with a stubbed AWS SDK:
    - the only tool sent is the output schema;
    - a profile with an `eu-west-2` destination, retention `default`, or an AccessDenied read → startup refuses

- [x] T36: [BE] meetings-api prompt builders and output validators: summary (server-rendered headings from the snapshot, `notDiscussed` localised, index coverage), answer (citation filtering, uncited → `notInMeeting`, last 10 turns), transcript block escaping, inputs limited to transcript + template — refs: AC-7.2, AC-7.10, AC-7.12, AC-8.6, AC-9.2, AC-9.3, AC-9.4, AC-9.7 — deps: T35
  - touch: `meetings-api/src/ai/prompts/*.ts`, `meetings-api/src/ai/prompts/*.test.ts`
  - done when: `cd meetings-api && bun test src/ai/prompts` passes, covering:
    - request snapshots (system prompt + template + transcript only; 10 turns, not 11);
    - an escaped `</transcript>` / `[S` inside segment text;
    - hostile fake outputs (extra or renamed sections, missing index, forged citations, URL in output, prose claiming to be system) are rejected or neutralised;
    - built-in headings in the output language

- [x] T37: [BE] meetings-api built-in templates (four, en + it, read-only) and `GET /templates?meetingId=` ordering (recommended for the meeting's host, personal, shared, built-in; `version` per item) — refs: AC-8.1, AC-8.5, AC-8.6 — deps: T13, T15, T12
  - touch: `meetings-api/src/templates/builtin.ts`, `meetings-api/src/templates/builtin.test.ts`, `meetings-api/src/templates/templates.routes.ts`, `meetings-api/src/templates/templates.list.test.ts`
  - done when: `cd meetings-api && bun test src/templates/builtin.test.ts src/templates/templates.list.test.ts` passes: four names in both languages with parity; Sales discovery call first for a `crm/deal` meeting; order and `source` / `recommended` flags asserted

- [x] T38: [BE] meetings-api template CRUD and duplicate: personal (unique among own), shared (`template:manage`, unique case-insensitive), built-in read-only, `PATCH` with If-Match (G8), duplicate built-in/shared → personal — refs: AC-8.2, AC-8.3, AC-8.4, AC-8.7 — deps: T37
  - touch: `meetings-api/src/templates/templates.routes.ts`, `meetings-api/src/templates/templates.crud.test.ts`
  - done when: `cd meetings-api && bun test src/templates/templates.crud.test.ts` passes:
    - limits 80 / 15 / 80 / 500 / 2000 → 422 just past each;
    - duplicate name → 409; shared without the permission → 403; built-in → 403 `builtin_readonly`;
    - PATCH without If-Match → 428, stale → 409;
    - another user cannot see a personal template

- [x] T39: [BE] meetings-api AI rate limiter: `ai_request` rows, 30 per user per rolling hour under an advisory lock, `Retry-After`, per-user pruning on insert — refs: AC-13.4, AC-9.8 — deps: T12
  - touch: `meetings-api/src/ai/rateLimit.ts`, `meetings-api/src/ai/rateLimit.test.ts`
  - done when: `cd meetings-api && bun test src/ai/rateLimit.test.ts` passes with a fixed clock: the 31st call → limited with the exact `Retry-After`; concurrent calls never exceed 30; deleting content does not refund

- [x] T40: [BE] meetings-api summaries routes (list with per-item `can`, generate, regenerate, retry, PATCH with If-Match, DELETE) (≤ 20 under lock, template snapshot, derived `failed` after 10 min, stale flag) — refs: AC-7.1, AC-7.3, AC-7.4, AC-7.5, AC-7.7, AC-7.8, AC-7.11, AC-6.8 — deps: T93, T37, T39, T94
  - touch: `meetings-api/src/summaries/summaries.routes.ts`, `meetings-api/src/summaries/summaries.test.ts`
  - done when: `cd meetings-api && bun test src/summaries/summaries.test.ts` passes with the fake LLM, covering:
    - generate → `generating` → `ready`;
    - the 21st → 409; regenerate keeps the old row;
    - the template edited or deleted afterwards leaves the snapshot byte-identical;
    - per-item `can` equals the route outcome for author / creator / other / no-access;
    - `no_speech` → 409; participant without access → 403
    - (re-sync 2026-11-05, plan amendment T94) generate/regenerate store `template.speakerNames` resolved with the caller's token (unknown → "Speaker n"), retry keeps the stored map, and the `summarize` job uses only that map
  - touch (re-sync): also `meetings-api/src/jobs/handlers/summarize.ts`, `meetings-api/src/templates/templates.routes.ts` (recommended templates via the shared visibility helper)

- [x] T94: [BE] meetings-api `summarize` job: builds the prompt from the summary's snapshot and the current transcript, validates the output (T36), writes `ready` sections or `failed` + code under the `attemptId` guard, and notifies the author (title + outcome only) — refs: AC-7.5, AC-7.6, AC-7.9 — deps: T16, T17, T36
  - touch: `meetings-api/src/jobs/handlers/summarize.ts`, `meetings-api/src/jobs/handlers/summarize.test.ts`
  - done when: `cd meetings-api && bun test src/jobs/handlers/summarize.test.ts` passes with the fake LLM:
    - success writes sections in template order;
    - timeout / 5xx / invalid output → `failed` with no partial sections;
    - a stale `attemptId` result is discarded;
    - exactly one push, to the author

- [x] T41: [BE] meetings-api conversation routes: own turns only, ask (synchronous, persisted `pending` → `answered`/`failed`, derived `failed` after 2 min), retry, clear — refs: AC-9.1, AC-9.3, AC-9.5, AC-9.6, AC-9.8 — deps: T93, T36, T39
  - touch: `meetings-api/src/conversation/conversation.routes.ts`, `meetings-api/src/conversation/conversation.test.ts`
  - done when: `cd meetings-api && bun test src/conversation/conversation.test.ts` passes with the fake LLM:
    - 0 / 1001 chars → 422;
    - unknown citations dropped, uncited → `notInMeeting`;
    - the creator cannot read a participant's turns, and clear deletes only the caller's;
    - an LLM timeout → `failed` with no answer text;
    - the 31st request → 429

- [x] T42: [BE] meetings-api assembled-app tests: role × action authorization matrix over the real route table, log-privacy canary test across every route and job, auth-outage test — refs: AC-5.8, AC-5.3, AC-4.8, AC-4.10, AC-10.4, AC-10.6 — deps: T19, T21, T22, T23, T24, T25, T27, T28, T29, T32, T33, T34, T38, T40, T41
  - touch: `meetings-api/src/matrix.test.ts`, `meetings-api/src/logPrivacy.test.ts`, `meetings-api/src/authz-outage.test.ts`
  - done when: `cd meetings-api && bun test` passes in full on `meetings_test`:
    - every route appears in the matrix, and each cell gets its expected 2xx or 403 code;
    - not-visible and nonexistent ids give byte-identical 404s;
    - canary strings planted in title, transcript, summary, question and answer never appear in captured console output;
    - with resolve at 503, creator and participant reads give 200 and capability routes 503

- [x] T43: [OPS] Register meetings-api's copied modules (`serviceToken`, `s3Residency`, JWT/authz middleware) in the shared-copies check — refs: AC-4.9 — deps: T13, T14, T16
  - touch: `scripts/check-shared-copies.ts`
  - done when: `mise run shared:check` passes, and fails if one meetings-api copy is edited alone

- [x] T44: [FE] operai-ui `ProgressBar` (determinate + indeterminate, `role="progressbar"`, text alternative prop, reduced motion) with story and test — refs: AC-2.7, AC-3.1 — deps: none
  - touch: `operai-ui/src/components/ProgressBar*.tsx`, `operai-ui/src/index.ts`
  - done when: `mise run ui:check` passes, including the new `ProgressBar.test.tsx` (aria values, indeterminate has no `aria-valuenow`)

- [x] T45: [FE] operai-ui `formatDuration(ms, {style: 'clock' | 'spoken'})` and `Icon` additions `mic`, `pause`, `play`, `stop` — refs: AC-2.2, AC-6.1, AC-13.3 — deps: T44
  - touch: `operai-ui/src/lib/format.ts`, `operai-ui/src/lib/i18n-format.test.tsx`, `operai-ui/src/components/Icon.tsx`, `operai-ui/src/components/Icon.stories.tsx`, `operai-ui/src/index.ts`
  - done when: `mise run ui:check` passes with new vectors (`0` → `00:00:00`, `3_723_000` → `01:02:03`, spoken en/it incl. the `Intl.DurationFormat` fallback) and the four icons rendered in the story test

- [x] T46: [FE] operai-ui `FilePicker` (hidden input + Button + selected-file line, `accept`, clear, `Field` wiring) with story and test — refs: AC-3.1, AC-3.2 — deps: T45
  - touch: `operai-ui/src/components/FilePicker*.tsx`, `operai-ui/src/index.ts`
  - done when: `mise run ui:check` passes, including keyboard activation, the name and size line, clear, and the error wired through `aria-describedby`

- [x] T47: [FE] operai-ui `PersonPicker` extracted from crm-ui (injected `load`, filter by name/email, `exclude`, `clearOnSelect`, rate-limit message; copy as props); crm-ui migrated to it — refs: AC-5.1 — deps: T46
  - touch: `operai-ui/src/components/PersonPicker*.tsx`, `operai-ui/src/index.ts`, `crm-ui/src/components/PersonPicker.tsx`, `crm-ui/src/components/ParticipantsField.tsx`
  - done when: `mise run ui:check` passes, and `cd crm-ui && pnpm lint && pnpm build && pnpm test` passes unchanged in behaviour (existing picker tests green)

- [x] T48: [FE] operai-ui `SectionsEditor` extracted (rows, reorder, min/max, per-row errors, `renderRowExtra`); crm-ui's offer-template editor migrated through the slot — refs: AC-8.2 — deps: T47
  - touch: `operai-ui/src/components/SectionsEditor*.tsx`, `operai-ui/src/index.ts`, `crm-ui/src/components/SectionsEditor.tsx`, `crm-ui/src/pages/TemplateEditorPage.tsx`
  - done when: `mise run ui:check` passes, and `cd crm-ui && pnpm test src/pages/OfferTemplates.test.tsx` passes

- [x] T49: [FE] shell: `meetings` remote (vite config, runtime remotes, ambient types, stubs, About version source), routes `/meetings/$` (gated) and `/my-meetings/$` (ungated), `TOOLS` entry + sidebar icon `mic`, UserMenu "My meetings", `@source meetings-ui/src`, strings en/it — refs: AC-10.1, AC-10.4, AC-10.5, AC-1.4 — deps: T45
  - touch: `shell/vite.config.ts`, `shell/src/lib/runtimeRemotes.ts`, `shell/src/lib/runtimeRemotes.test.ts`, `shell/src/federation/*`, `shell/src/router.tsx`, `shell/src/router.meetings.test.tsx`, `shell/src/lib/tools.ts`, `shell/src/lib/tools.test.ts`, `shell/src/components/UserMenu.tsx`, `shell/src/components/UserMenu.test.tsx`, `shell/src/components/Sidebar.tsx`, `shell/src/components/AboutModal.tsx`, `shell/src/strings.ts`, `shell/src/index.css`
  - done when: `cd shell && pnpm lint && pnpm build && pnpm test` passes; `router.meetings.test.tsx` shows `/my-meetings/*` mounting `meetings/MyMeetings` for a zero-grant user and `/meetings/*` going to no-access without `meetings`

- [x] T50: [FE] shell: `getMeetingsApiBaseUrl()` + trusted origin (`VITE_MEETINGS_API_URL`), `registerNavigationBlocker(shouldBlock, message)` in `session.ts`, and the shell's `useBlocker` + `ConfirmDialog` ("Leave this page?", focus on Stay) — refs: AC-2.10 — deps: T49
  - touch: `shell/src/lib/session.ts`, `shell/src/lib/session.test.ts`, `shell/src/components/ShellLayout.tsx`, `shell/src/components/ShellLayout.test.tsx`, `shell/src/strings.ts`, `shell/src/vite-env.d.ts`
  - done when: `cd shell && pnpm test src/lib/session.test.ts src/components/ShellLayout.test.tsx` passes:
    - Bearer attached only to the meetings-api origin;
    - a registered blocker shows the dialog and Stay cancels the navigation;
    - unregistering lets navigation through

- [x] T51: [FE] shell: `./extensions` expose with `HostExtension` (loads `meetings/HostMeetings`, 5 s race, error boundary, missing export → fallback) — refs: AC-11.6 — deps: T49
  - touch: `shell/src/lib/extensions.tsx`, `shell/src/lib/extensions.test.tsx`, `shell/vite.config.ts`, `shell/src/federation/*`
  - done when: `cd shell && pnpm test src/lib/extensions.test.tsx && pnpm build` passes; the test renders the fallback for a rejected import, for a 5 s timeout (fake timers), for a module without the export and for a component that throws on render, and never rethrows

- [x] T52: [FE] shell `vercel.json`: CSP `connect-src` + meetings-api + meetings bucket, `media-src` bucket, `script-src` meetings remote; `Permissions-Policy: microphone=(self), display-capture=(self), camera=()` — refs: AC-2.2, AC-6.5, AC-2.4 — deps: none
  - touch: `shell/vercel.json`, `shell/src/vercelHeaders.test.ts`
  - done when: `cd shell && pnpm test src/vercelHeaders.test.ts` passes, parsing `vercel.json` and asserting each directive and the `Permissions-Policy` value

- [x] T53: [FE] meetings-ui scaffold:
  - package, vite config exposing `./App`, `./MyMeetings`, `./HostMeetings`, `./version` (port 5180, singletons, `@operai/ui` alias + dedupe);
  - vitest config with `shell/session` stub (incl. `registerNavigationBlocker`);
  - both routers with placeholder pages;
  - placeholder card components that already export their final prop types (`design.md` S3–S6), so T57 composes them once and later tasks replace each body in place;
  - strings aggregator over per-area modules (en + it), parity and hard-coded-copy tests.

  refs: AC-13.1 — deps: none
  - touch: `meetings-ui/package.json`, `meetings-ui/pnpm-lock.yaml`, `meetings-ui/vite.config.ts`, `meetings-ui/vitest.config.ts`, `meetings-ui/tsconfig*.json`, `meetings-ui/eslint.config.js`, `meetings-ui/postcss.config.js`, `meetings-ui/index.html`, `meetings-ui/vercel.json`, `meetings-ui/src/*.ts`, `meetings-ui/src/*.tsx`, `meetings-ui/src/index.css`, `meetings-ui/src/federation/**`, `meetings-ui/src/strings/*.ts`, `meetings-ui/src/pages/*.tsx`, `meetings-ui/src/components/**/*.tsx`, `meetings-ui/src/host/HostMeetings.tsx`
  - done when: `cd meetings-ui && pnpm install && pnpm lint && pnpm build && pnpm test` passes, including `strings.test.ts` (`catalogGaps` empty) and the no-hard-coded-copy scan; `dist/remoteEntry.js` exposes the four entries

- [x] T54: [FE] meetings-ui data layer: typed API client for every plan route, types, problem `code` → strings key map, status meanings map, `LoadState`/`PermissionDenied` adapters, hooks (resource, polling with backoff, capability hints from `usePermissions` per G5), `test-support/fakeApi.ts` fixtures — refs: AC-5.3, AC-10.4, AC-10.6 — deps: T53
  - touch: `meetings-ui/src/lib/*.ts`, `meetings-ui/src/lib/*.test.ts`, `meetings-ui/src/hooks/*`, `meetings-ui/src/test-support/*`, `meetings-ui/src/components/LoadState.tsx`, `meetings-ui/src/components/PermissionDenied.tsx`, `meetings-ui/src/strings/common.ts`
  - done when: `cd meetings-ui && pnpm test src/lib src/hooks` passes:
    - 404 → not-found state, 503 → authorization-unavailable banner key;
    - every problem code of the plan has a strings key (exhaustiveness test);
    - capability hints read `apps` / `{resource, action}`

- [x] T55: [FE] meetings-ui meetings list (both entries): DataTable, filters (q, role, status, host app), pagination, host column states, empty states with/without "New meeting"; Templates link for holders — refs: AC-10.1, AC-10.2, AC-10.3, AC-10.5, AC-10.7, AC-11.5 — deps: T54
  - touch: `meetings-ui/src/pages/MeetingsListPage.tsx`, `meetings-ui/src/pages/MeetingsListPage.test.tsx`, `meetings-ui/src/strings/list.ts`
  - done when: `cd meetings-ui && pnpm test src/pages/MeetingsListPage.test.tsx` passes, rendering:
    - the four host states ("Deal · title" link, "CRM · deal", "No longer available");
    - both empty states;
    - filters producing the expected query

- [x] T56: [FE] meetings-ui new meeting page: form (title, format, date-time default now, language, source), host prefill from `GET /hosts/:app/:type/:id` shown as "<Entity> · <title>", host errors (not found, not registered, unavailable with retry and the standalone option) — refs: AC-1.1, AC-1.2, AC-1.3, AC-1.5, AC-1.6, AC-11.6 — deps: T54
  - touch: `meetings-ui/src/pages/NewMeetingPage.tsx`, `meetings-ui/src/pages/NewMeetingPage.test.tsx`, `meetings-ui/src/strings/newMeeting.ts`
  - done when: `cd meetings-ui && pnpm test src/pages/NewMeetingPage.test.tsx` passes: invalid fields named and focused; prefilled title and host label; each host error state; standalone submit without a host

- [x] T57: [FE] meetings-ui meeting page frame: header, details card (incl. consent facts), one-at-a-time status panels (processing stages, failed with reason and Retry, no speech, frozen banner), tabs and card slots — refs: AC-4.3, AC-5.11, AC-6.7, AC-6.9, AC-6.10, AC-10.4 — deps: T54
  - touch: `meetings-ui/src/pages/MeetingPage.tsx`, `meetings-ui/src/pages/MeetingPage.test.tsx`, `meetings-ui/src/components/meeting/StatusPanels.tsx`, `meetings-ui/src/components/meeting/DetailsCard.tsx`, `meetings-ui/src/strings/meeting.ts`
  - done when: `cd meetings-ui && pnpm test src/pages/MeetingPage.test.tsx` passes, rendering each status panel from fixtures:
    - a read-only participant (`can.*` false) sees no create/summarise/ask/edit control;
    - the frozen banner;
    - attestation facts;
    - Retry only when `can.retryProcessing`

- [x] T58: [FE] meetings-ui Edit details dialog: title, date-time, format, language (`can.changeLanguage`), source switch (`can.changeSource`, G1), host-visible checkbox with the host's `visibilityHint` (G6), Remove link — refs: AC-1.7, AC-1.8, AC-2.3, AC-3.5, AC-5.5 — deps: T54
  - touch: `meetings-ui/src/components/meeting/EditDetailsDialog.tsx`, `meetings-ui/src/components/meeting/EditDetailsDialog.test.tsx`, `meetings-ui/src/strings/editDetails.ts`
  - done when: `cd meetings-ui && pnpm test src/components/meeting/EditDetailsDialog.test.tsx` passes:
    - locked fields come from `can` flags;
    - the hint text comes from the registry fixture;
    - the checkbox is absent for a standalone meeting;
    - Remove link sends `host: null`

- [x] T59: [FE] meetings-ui host-notice failure banner: non-blocking, the host's `noticeFailed` sentence, Try again (absent when frozen) — refs: AC-11.9, AC-14.8, AC-14.10 — deps: T57
  - touch: `meetings-ui/src/components/meeting/HostNoticeBanner.tsx`, `meetings-ui/src/components/meeting/HostNoticeBanner.test.tsx`, `meetings-ui/src/strings/meeting.ts`
  - done when: `cd meetings-ui && pnpm test src/components/meeting/HostNoticeBanner.test.tsx` passes: en/it sentence from the registry, retry calls the route and hides on success, no Try again when frozen

- [x] T60: [FE] meetings-ui participants card + Edit participants dialog (library `PersonPicker` over the directory with NO `appId`, G9; external name/organisation; ≤ 30; deleted users shown as deleted) — refs: AC-5.1, AC-5.4, AC-5.10 — deps: T47, T54
  - touch: `meetings-ui/src/components/meeting/ParticipantsCard.tsx`, `meetings-ui/src/components/meeting/EditParticipantsDialog.tsx`, `meetings-ui/src/components/meeting/Participants.test.tsx`, `meetings-ui/src/strings/participants.ts`
  - done when: `cd meetings-ui && pnpm test src/components/meeting/Participants.test.tsx` passes:
    - the directory request URL has no `appId`;
    - the 31st add is blocked;
    - external validation 1..100;
    - "Deleted user" rendering;
    - focus moves after removal

- [x] T61: [FE] meetings-ui consent card: versioned notice (en/it, the five required statements), explicit tick, copyable announcement; capture controls hidden until attested — refs: AC-4.1, AC-4.2, AC-2.1 — deps: T54
  - touch: `meetings-ui/src/components/meeting/ConsentCard.tsx`, `meetings-ui/src/components/meeting/ConsentCard.test.tsx`, `meetings-ui/src/strings/consent.ts`
  - done when: `cd meetings-ui && pnpm test src/components/meeting/ConsentCard.test.tsx` passes:
    - Proceed disabled until ticked, and posts the notice version;
    - the clipboard gets the localised announcement;
    - a string test checks each required statement in both languages

- [x] T62: [FE] meetings-ui capture capabilities matrix and Web Audio mixer (mic + optional tab audio; tab track end / no audio track → event; mic keeps feeding) — refs: AC-2.4, AC-2.5 — deps: T53
  - touch: `meetings-ui/src/capture/capabilities.ts`, `meetings-ui/src/capture/capabilities.test.ts`, `meetings-ui/src/capture/mixer.ts`, `meetings-ui/src/capture/mixer.test.ts`
  - done when: `cd meetings-ui && pnpm test src/capture/capabilities.test.ts src/capture/mixer.test.ts` passes: stubbed navigators for Chrome, Edge, Firefox and Safari give the expected options; the mixer emits `tabAudioLost` and still routes the mic node

- [x] T63: [FE] meetings-ui `RecordingSession` controller + chunk uploader:
  - MediaRecorder 10 s timeslice;
  - pause excluded from durations;
  - pre-minted next policy;
  - in-memory queue with backoff while offline;
  - heartbeats with `capturedMs`;
  - 2 h 50 warning / 3 h auto-stop;
  - stop flushes then calls `stop`;
  - no browser storage APIs.

  refs: AC-2.1, AC-2.6, AC-2.8, AC-2.9, AC-2.11, AC-4.11 — deps: T54, T62
  - touch: `meetings-ui/src/capture/session.ts`, `meetings-ui/src/capture/session.test.ts`, `meetings-ui/src/capture/uploader.ts`, `meetings-ui/src/capture/uploader.test.ts`, `meetings-ui/src/capture/noStorage.test.ts`
  - done when: `cd meetings-ui && pnpm test src/capture` passes with a fake MediaRecorder and fake timers, covering:
    - `getUserMedia` is never called before consent;
    - a paused span adds no chunks or duration;
    - offline chunks are retried in order after reconnect;
    - `capturedMs` is sent;
    - warning at 2 h 50 and stop at 3 h;
    - a static scan finds no `indexedDB` / `caches` / `localStorage` / `sessionStorage` in `src/capture`

- [x] T64: [FE] meetings-ui recording panel: capture options per capability, indicator (icon + text + elapsed `role="timer"`), Start/Pause/Resume/Stop by keyboard, polite live region, mic denied/no device message with upload/paste offers, tab-audio-lost banner, offline "not yet saved, only while this tab stays open", save progress (`ProgressBar`), `beforeunload` + shell navigation blocker registration — refs: AC-2.2, AC-2.3, AC-2.4, AC-2.5, AC-2.7, AC-2.10, AC-2.11, AC-13.3 — deps: T44, T45, T63
  - touch: `meetings-ui/src/components/meeting/RecordingPanel.tsx`, `meetings-ui/src/components/meeting/RecordingPanel.test.tsx`, `meetings-ui/src/strings/capture.ts`
  - done when: `cd meetings-ui && pnpm test src/components/meeting/RecordingPanel.test.tsx` passes:
    - keyboard-only start/pause/resume/stop with live-region announcements;
    - focus moves as `design.md` § Accessibility describes;
    - `NotAllowedError` keeps `draft` and offers upload/paste;
    - `beforeunload` and the blocker are registered while recording or unsaved, and released after;
    - axe finds no violation on the rendered panel

- [x] T65: [FE] meetings-ui interrupted panel: duration kept, `lostMs` "at least …" or the fallback sentence, Process what was captured / Discard (confirm) — refs: AC-2.8, AC-2.9 — deps: T64
  - touch: `meetings-ui/src/components/meeting/InterruptedPanel.tsx`, `meetings-ui/src/components/meeting/InterruptedPanel.test.tsx`, `meetings-ui/src/strings/capture.ts`
  - done when: `cd meetings-ui && pnpm test src/components/meeting/InterruptedPanel.test.tsx` passes for `lostMs` = null / 0 / > 0, process and discard calls, and Process hidden once audio is deleted

- [x] T66: [FE] meetings-ui upload card: `FilePicker`, client pre-check (type, ≤ 500 MiB, duration via `loadedmetadata`), XHR presigned POST with `ProgressBar`, failure + Retry, server rejection reasons — refs: AC-3.1, AC-3.2, AC-3.3 — deps: T44, T46, T54
  - touch: `meetings-ui/src/components/meeting/UploadCard.tsx`, `meetings-ui/src/components/meeting/UploadCard.test.tsx`, `meetings-ui/src/strings/upload.ts`
  - done when: `cd meetings-ui && pnpm test src/components/meeting/UploadCard.test.tsx` passes with a fake XHR: progress shown; abort or error → Retry; each `upload_rejected` reason gets its own message; an oversize file is refused before upload

- [x] T67: [FE] meetings-ui text card: paste/type up to 200,000 characters with a counter, save → ready — refs: AC-3.4 — deps: T54
  - touch: `meetings-ui/src/components/meeting/TextCard.tsx`, `meetings-ui/src/components/meeting/TextCard.test.tsx`, `meetings-ui/src/strings/text.ts`
  - done when: `cd meetings-ui && pnpm test src/components/meeting/TextCard.test.tsx` passes: the counter, refusal at 200,001, and no consent step shown

- [x] T68: [FE] meetings-ui transcript view: segments with time + speaker (none for text), search with case- and accent-folding, highlights and live count, copy and plain-text download with names, citation target highlight prop — refs: AC-6.1, AC-6.4, AC-6.6, AC-6.7 — deps: T45, T54
  - touch: `meetings-ui/src/components/transcript/TranscriptView.tsx`, `meetings-ui/src/components/transcript/SegmentRow.tsx`, `meetings-ui/src/components/transcript/Highlight.tsx`, `meetings-ui/src/components/transcript/fold.ts`, `meetings-ui/src/components/transcript/exportText.ts`, `meetings-ui/src/components/transcript/TranscriptView.test.tsx`, `meetings-ui/src/components/transcript/fold.test.ts`, `meetings-ui/src/strings/transcript.ts`
  - done when: `cd meetings-ui && pnpm test src/components/transcript` passes: `fold` vectors ("perché" ~ "PERCHE"); match count; export lines `[hh:mm:ss] Name: text`; text meeting without times; no-speech message

- [x] T69: [FE] meetings-ui transcript corrections: inline segment edit with If-Match (stale → reload banner), "edited" mark, speaker rename dialog (participant or free text) — refs: AC-6.2, AC-6.3 — deps: T68
  - touch: `meetings-ui/src/components/transcript/SegmentEditor.tsx`, `meetings-ui/src/components/transcript/SpeakerRenameDialog.tsx`, `meetings-ui/src/components/transcript/Corrections.test.tsx`, `meetings-ui/src/strings/transcript.ts`
  - done when: `cd meetings-ui && pnpm test src/components/transcript/Corrections.test.tsx` passes: 409 shows the reload banner; the rename updates every segment of that speaker; the controls are absent without `can.editTranscript`

- [x] T70: [FE] meetings-ui audio: play-from-segment control while audio is kept (re-mint on media error), "Audio kept until <date>" / "Audio deleted", Delete recording dialog — refs: AC-4.4, AC-4.5, AC-6.5 — deps: T45, T54
  - touch: `meetings-ui/src/components/transcript/AudioControl.tsx`, `meetings-ui/src/components/transcript/AudioControl.test.tsx`, `meetings-ui/src/components/meeting/DeleteRecordingDialog.tsx`, `meetings-ui/src/strings/audio.ts`
  - done when: `cd meetings-ui && pnpm test src/components/transcript/AudioControl.test.tsx` passes: the control is absent for `deleted`; the date is formatted; a media `error` re-mints once; the delete dialog calls the route

- [x] T71: [FE] meetings-ui summaries panel: list, Generate dialog (template picker order + recommended marker, output language default = UI language), card (sections in order, "Not discussed", "AI-generated" + template/language/author/time, stale label), Regenerate, Retry, copy, 20-limit and rate-limit messages, per-item `can` — refs: AC-7.1, AC-7.2, AC-7.3, AC-7.4, AC-7.6, AC-7.9, AC-7.11, AC-6.8, AC-8.5, AC-13.4 — deps: T54
  - touch: `meetings-ui/src/components/summaries/SummariesPanel.tsx`, `meetings-ui/src/components/summaries/SummaryCard.tsx`, `meetings-ui/src/components/summaries/GenerateSummaryDialog.tsx`, `meetings-ui/src/components/summaries/Summaries.test.tsx`, `meetings-ui/src/strings/summaries.ts`
  - done when: `cd meetings-ui && pnpm test src/components/summaries/Summaries.test.tsx` passes, covering:
    - picker order;
    - `generating` → `ready` via polling;
    - the failed card with Retry;
    - the stale label;
    - copy as text;
    - the 429 message names the retry time;
    - text rendered as plain text (an injected `<img>` / Markdown link appears literally)

- [x] T72: [FE] meetings-ui summary edit (If-Match, "edited") and delete (confirm), driven by per-item `can` — refs: AC-7.7, AC-7.8 — deps: T71
  - touch: `meetings-ui/src/components/summaries/SummaryEditor.tsx`, `meetings-ui/src/components/summaries/DeleteSummaryDialog.tsx`, `meetings-ui/src/components/summaries/SummaryEdit.test.tsx`, `meetings-ui/src/strings/summaries.ts`
  - done when: `cd meetings-ui && pnpm test src/components/summaries/SummaryEdit.test.tsx` passes: menu items follow `can.edit` / `can.delete`; 409 shows the reload banner; delete asks to confirm

- [x] T73: [FE] meetings-ui Ask panel: conversation (own), composer 1..1000, answer with "AI-generated" and sources (time + speaker), source → transcript tab + segment focus, "not in the meeting" answer, failed turn + Retry, clear conversation, rate-limit message — refs: AC-9.1, AC-9.3, AC-9.5, AC-9.6, AC-9.8 — deps: T54
  - touch: `meetings-ui/src/components/ask/AskPanel.tsx`, `meetings-ui/src/components/ask/Turn.tsx`, `meetings-ui/src/components/ask/Composer.tsx`, `meetings-ui/src/components/ask/Sources.tsx`, `meetings-ui/src/components/ask/Ask.test.tsx`, `meetings-ui/src/strings/ask.ts`
  - done when: `cd meetings-ui && pnpm test src/components/ask/Ask.test.tsx` passes:
    - selecting a source calls `onCite(segmentId)`;
    - `notInMeeting` shows no sources;
    - a failed turn shows Retry;
    - clear asks to confirm;
    - the composer refuses 0 and 1001 characters

- [x] T74: [FE] meetings-ui templates pages: list (personal / shared / built-in marked), view, editor on the library `SectionsEditor`, duplicate, shared scope only with the `template:manage` hint, If-Match conflict banner — refs: AC-8.1, AC-8.2, AC-8.3, AC-8.4 — deps: T48, T54
  - touch: `meetings-ui/src/pages/TemplatesPage.tsx`, `meetings-ui/src/pages/TemplateViewPage.tsx`, `meetings-ui/src/pages/TemplateEditorPage.tsx`, `meetings-ui/src/pages/Templates.test.tsx`, `meetings-ui/src/strings/templates.ts`
  - done when: `cd meetings-ui && pnpm test src/pages/Templates.test.tsx` passes:
    - built-ins have no edit or delete;
    - field limits are validated inline;
    - the shared option is hidden without the hint;
    - 409 shows the reload banner;
    - duplicate opens the editor on the copy

- [x] T75: [FE] meetings-ui Erase page (search by title / creator / date, title + date + creator only, delete) and the Delete meeting dialog (cannot be undone, `acknowledgeLabel`) — refs: AC-4.6, AC-4.7, AC-5.12 — deps: T47, T54
  - touch: `meetings-ui/src/pages/ErasePage.tsx`, `meetings-ui/src/pages/ErasePage.test.tsx`, `meetings-ui/src/components/meeting/DeleteMeetingDialog.tsx`, `meetings-ui/src/components/meeting/DeleteMeetingDialog.test.tsx`, `meetings-ui/src/strings/erase.ts`
  - done when: `cd meetings-ui && pnpm test src/pages/ErasePage.test.tsx src/components/meeting/DeleteMeetingDialog.test.tsx` passes: no link from erase rows to content; the dialog needs the acknowledgement; the Erase tab is hidden without the `meeting:erase` hint

- [x] T76: [FE] meetings-ui `HostMeetings` panel: list for the entity (title, date, status, summaries, creator; links to `/my-meetings/m/<id>`), empty state with Start meeting for holders, unavailable state, "Link an existing meeting" dialog over the linkable list (G2) → `PATCH host` — refs: AC-1.4, AC-1.7, AC-11.2, AC-11.3, AC-11.6, AC-14.1 — deps: T54
  - touch: `meetings-ui/src/host/HostMeetings.tsx`, `meetings-ui/src/host/LinkMeetingDialog.tsx`, `meetings-ui/src/host/HostMeetings.test.tsx`, `meetings-ui/src/strings/host.ts`
  - done when: `cd meetings-ui && pnpm test src/host` passes:
    - holder vs non-holder controls;
    - `navigateSuite` called with the new-meeting URL;
    - the link dialog radio group is disabled until a choice and sends the current host ref;
    - a 503 gives the unavailable state;
    - no count of hidden meetings is rendered

- [x] T77: [FE] crm-ui: Meetings section on the deal page through `shell/extensions` (dynamic import, fallback banner with the same heading when absent or failing), ambient type + stub; the company page has no meetings section — refs: AC-11.2, AC-11.6, AC-11.7 — deps: none
  - touch: `crm-ui/src/pages/DealDetailPage.tsx`, `crm-ui/src/pages/DealDetailPage.test.tsx`, `crm-ui/src/components/MeetingsSection.tsx`, `crm-ui/src/components/MeetingsSection.test.tsx`, `crm-ui/src/pages/CompanyDetailPage.meetings.test.tsx`, `crm-ui/src/federation/remotes.d.ts`, `crm-ui/src/federation/__stubs__/shellExtensions.ts`, `crm-ui/vitest.config.ts`, `crm-ui/src/strings/deals.ts`
  - done when: `cd crm-ui && pnpm lint && pnpm build && pnpm test` passes:
    - the section passes `{hostApp:"crm", entityType:"deal", entityId}`;
    - a rejected `import('shell/extensions')` shows the fallback;
    - the company page renders no extension

- [x] T78: [FE] crm-ui: an activity with `meeting` renders "Open meeting" linking to `/my-meetings/m/<id>` (no body) — refs: AC-14.2, AC-14.4 — deps: none
  - touch: `crm-ui/src/components/ActivityItem.tsx`, `crm-ui/src/components/ActivityItem.test.tsx`, `crm-ui/src/lib/types.ts`, `crm-ui/src/strings/activities.ts`
  - done when: `cd crm-ui && pnpm test src/components/ActivityItem.test.tsx` passes with a meeting-activity fixture (link href, no body, author by live name)

- [x] T79: [FE] notify-ui list item and shell `ToastHost` pick the `it` variant under `<html lang="it">`; origin label `meetings` — refs: AC-12.5 — deps: none
  - touch: `notify-ui/src/components/NotificationItem.tsx`, `notify-ui/src/components/NotificationItem.test.tsx`, `notify-ui/src/lib/notificationsApi.ts`, `notify-ui/src/lib/severity.ts`, `notify-ui/src/strings.ts`, `shell/src/components/ToastHost.tsx`, `shell/src/components/ToastHost.test.tsx`, `shell/src/lib/notifications.ts`
  - done when: `cd notify-ui && pnpm test && cd ../shell && pnpm test src/components/ToastHost.test.tsx` passes: Italian variant under `lang="it"`, English otherwise, fallback when `it` is null

- [x] T80: [OPS] Repo wiring: `lerna.json` (meetings-api, meetings-ui), `mise.toml` (`dev`, `dev:web`, `dev:preview`, `db:migrate` incl. `meetings`, `ui:check` consumers) — refs: AC-10.5, AC-11.4 — deps: T10, T53
  - touch: `lerna.json`, `mise.toml`
  - done when: `mise tasks ls` lists the updated tasks; `mise run db:migrate` migrates `meetings`; `mise run ui:check` builds and tests meetings-ui; `pnpm changeset status` enumerates both new packages

- [x] T81: [OPS] env-doctor manifest + production template for meetings-api / meetings-ui. Covers:
  - origins;
  - the auth, notify and CRM link variables;
  - the service-client link `notifications.push host-notices.send`;
  - `MEETINGS_S3` required;
  - provider keys;
  - `SERVICE_AUDIENCE` for crm-api;
  - `mustAllow: ["shell"]`.

  refs: AC-4.9 — deps: none
  - touch: `tools/env-doctor/manifest.ts`, `tools/env-doctor/templates/production/*`, `tools/env-doctor/*.test.ts`
  - done when: `mise run env:doctor` passes on the production templates and the env-doctor test suite passes with new cases (missing `MEETINGS_S3_REGION`, missing `host-notices.send` scope, crm-api without `SERVICE_AUDIENCE` → reported)

- [x] T82: [OPS] `infra/meetings-bucket-policy.sh` (apply/check the 29-day lifecycle, versioning off, CORS for the shell origin on an S3-compatible endpoint) and the infra README section for meetings. The README covers:
  - the bucket;
  - Azure Speech in `westeurope`;
  - Bedrock retention `none` and model access;
  - `runtime-config` / shell env;
  - `provision-tool meetings --port 8085 --bucket`;
  - the `SERVICE_CLIENTS` entry.

  refs: AC-4.4, AC-4.9 — deps: T1
  - touch: `infra/meetings-bucket-policy.sh`, `infra/README.md`
  - done when: `bash -n infra/meetings-bucket-policy.sh` passes; `infra/meetings-bucket-policy.sh --check --endpoint http://localhost:9000 --bucket meetings` exits 0 against local MinIO, and exits non-zero after `mc ilm rule rm` on a scratch bucket

- [x] T83: [QE] Prompt-injection eval fixtures and runner. Synthetic it/en transcripts with planted instructions (ignore instructions, fake `</transcript><system>`, off-scope question, language switch, canary, URL). Deterministic assertions; `bun run eval` uses the fake LLM by default and `--live` uses the configured EU provider. The live run is documented as a release and model-change step — refs: AC-7.12, AC-9.7 — deps: T36, T40, T41
  - touch: `meetings-api/evals/**`, `meetings-api/package.json`, `meetings-api/README.md`
  - done when: `cd meetings-api && bun run eval` exits 0 against the fake LLM in CI mode, and exits non-zero when the fake is scripted to obey one planted instruction; `README.md` § Release lists `bun run eval --live` with `BEDROCK_MODEL_ID` as a required step

- [x] T84: [OPS] CI: `meetings-eval.yml` runs `bun run eval` (fake) on every PR touching `meetings-api/`, and a manually dispatched / nightly `--live` job using the eval key secret — refs: AC-7.12, AC-9.7 — deps: T83
  - touch: `.github/workflows/meetings-eval.yml`
  - done when: `actionlint .github/workflows/meetings-eval.yml` passes, and the PR job runs green on the branch

- [x] T85: [OPS] Docs: `AGENTS.md` (project structure, ports 8085/5180, tool table, services, data residency for meetings, ADR list 0058–0068) — refs: AC-11.1, AC-4.9 — deps: none
  - touch: `AGENTS.md`
  - done when: `grep -Ec 'docs/adr/00(5[89]|6[0-8])-' AGENTS.md` prints 11 and `mise run env:doctor` still passes (no contract drift introduced by the docs)

- [x] T86: [QE] e2e harness for meetings: `meetingsFixtures.ts` (seed meetings/participants via the API, start/stop the fake host, sessions with/without `meetings:access` / `crm-technical`), Playwright Chromium fake-media flags, stack env (`MEETINGS_AI_PROVIDER=fake`, `MEETINGS_TEST_HOSTS`) — refs: AC-11.4 — deps: T21, T23, T49, T80
  - touch: `shell/e2e/helpers/meetingsFixtures.ts`, `shell/e2e/meetings-smoke.spec.ts`, `shell/playwright.config.ts`
  - done when: `cd shell && pnpm e2e --list` lists the meetings projects, and `pnpm e2e meetings-smoke.spec.ts` (seed one meeting through the helper, open it in My meetings) passes against the running stack (`mise run dev`)

- [x] T87: [QE] e2e access journeys: a zero-grant user reaches My meetings from the user menu and sees only their own; a read-only participant has no controls and no sidebar entry; a holder sees Meetings with New meeting and Templates; a user without the grant sees no Start meeting on a deal — refs: AC-10.1, AC-10.4, AC-10.5, AC-1.4 — deps: T55, T57, T76, T77, T86
  - touch: `shell/e2e/meetings-access.spec.ts`
  - done when: `cd shell && pnpm e2e meetings-access.spec.ts` passes against the stack

- [x] T88: [QE] e2e deal journey: start meeting from a deal (prefilled "Deal · title") → consent → record with the fake device → stop → `ready` (fake AI) → the meeting is in the deal section and in My meetings → the deal timeline shows the activity; link an existing meeting from the panel; a CRM reader without access follows the activity link to not found; `crm-technical` cannot see a host-visible meeting — refs: AC-1.1, AC-2.2, AC-11.2, AC-11.3, AC-14.1, AC-14.4, AC-5.6 — deps: T9, T22, T32, T56, T61, T64, T76, T77, T78, T86
  - touch: `shell/e2e/meetings-deal.spec.ts`
  - done when: `cd shell && pnpm e2e meetings-deal.spec.ts` passes against the stack

- [x] T89: [QE] e2e capture robustness: offline 40 s then back → every chunk saved; close the page mid-recording → reopen shows `interrupted` with duration ≥ recorded − 20 s; sidebar click while recording → shell confirmation; after Stop and after Discard the browser storage is empty; keyboard-only recording and an axe pass on the capture page, meeting page and list — refs: AC-2.8, AC-2.9, AC-2.10, AC-4.11, AC-13.3 — deps: T27, T50, T57, T64, T65, T86
  - touch: `shell/e2e/meetings-capture.spec.ts`
  - done when: `cd shell && pnpm e2e meetings-capture.spec.ts` passes against the stack

- [x] T90: [QE] e2e failure and deletion: meetings-api stopped → the deal page loads with the Meetings-unavailable section; the creator deletes a meeting through the cannot-be-undone dialog → gone from lists, link → not found; an erase holder finds and deletes a meeting from Erase without seeing content — refs: AC-11.6, AC-4.6, AC-4.7 — deps: T25, T51, T75, T77, T86
  - touch: `shell/e2e/meetings-failure.spec.ts`
  - done when: `cd shell && pnpm e2e meetings-failure.spec.ts` passes against the stack

- [x] T91: [OPS] Changesets for every touched app (meetings-api, meetings-ui minor/new; shell, crm-ui, crm-api, auth, notify-api, notify-ui, operai-ui minor) — refs: AC-10.5 — deps: T2, T3, T4, T5, T9, T42, T48, T51, T52, T58, T59, T60, T65, T66, T67, T69, T70, T72, T73, T74, T76, T77, T78, T79, T80
  - touch: `.changeset/*.md`
  - done when: `mise run changeset:check` passes on the branch

## Amendment 2026-11-05 — provider change to Google Cloud (plan § G-17) and spec A5/A6

> Re-synced 2026-11-05 from plan § G-17 (approved by the user 2026-11-05) and spec amendments A5/A6.
> T31, T35 and the Azure/Bedrock parts of T11 are superseded (kept `[x]` as history). T81–T85 are
> reopened through T105, T106, T103, T104 and T109. T109 was done by the ADR-0069/0070 commit (f75209d).
> Added beyond G-17: T111/T112 (AC-4.1 consent disclosure, spec A6) and AC-4.12 on T96, T97, T102.

- [x] T95: [BE] meetings-api env + sync residency for Google. Removes `AZURE_*`, `BEDROCK_*` and `MEETINGS_AWS_*`. Adds `MEETINGS_SPEECH_LOCATION` {eu}, `MEETINGS_VERTEX_LOCATION` {eu, europe-west1, europe-west4}, `MEETINGS_VERTEX_MODEL_ID` (claude-, no fable/mythos), `MEETINGS_GCP_PROJECT_ID`, `MEETINGS_GCP_SERVICE_ACCOUNT_KEY` (base64 JSON, type/project/email/key checks) and `MEETINGS_GCS_TRANSIENT_BUCKET`. Refuses `ANTHROPIC_VERTEX_BASE_URL`; messages stay value-free — refs: AC-4.9 — deps: none
  - touch: `meetings-api/src/lib/env.ts`, `meetings-api/src/lib/env.test.ts`, `meetings-api/src/lib/residency.ts`, `meetings-api/src/lib/residency.test.ts`
  - done when: `cd meetings-api && bun test src/lib/env.test.ts src/lib/residency.test.ts` passes, with a case per S1–S6, including `global`, `us`, `europe-west2`, a `claude-fable-…` id, a key whose `project_id` differs, and a non-base64 key. No test output contains a configured value
- [x] T96: [BE] Google auth + transient storage + bucket startup check. Covers:
  - a google-auth-library JWT client from the explicit key (never ADC), token cached;
  - the GCS JSON API on the regional endpoint derived from the bucket location: upload with `ifGenerationMatch=0`, bounded read, list and delete of `transcribe/<meetingId>/` only (any other prefix refused), plus a fake;
  - `checkTransientBucket` (N2), wired into `runStartupChecks`.

  refs: AC-4.9, AC-4.5, AC-4.6, AC-4.12 — deps: T95
  - touch: `meetings-api/src/lib/google/auth.ts`, `meetings-api/src/lib/google/auth.test.ts`, `meetings-api/src/lib/google/transientStorage.ts`, `meetings-api/src/lib/google/transientStorage.test.ts`, `meetings-api/src/lib/startupChecks.ts`, `meetings-api/src/lib/startupChecks.test.ts`, `meetings-api/package.json`, `meetings-api/bun.lock`
  - done when: `bun test src/lib/google src/lib/startupChecks.test.ts` passes. It includes a refusal per N2 property (soft delete 7 d, versioning on, a `matchesPrefix` rule, age 2, `EUROPE-WEST2`, PAP not enforced, unreadable metadata), a test that `deletePrefix("transcribe/")` and other meetings' prefixes are refused, and a test that object URLs use `storage.<location>.rep.googleapis.com`
- [x] T98: [BE] Process-level ffmpeg slot. `withFfmpegSlot()` replaces the runner's `FFMPEG_KIND` exclusion; `prepare_audio` uses it; the minimal-child-env test lists `MEETINGS_GCP_SERVICE_ACCOUNT_KEY` — refs: AC-3.1, AC-6.10 — deps: none
  - touch: `meetings-api/src/media/ffmpegSlot.ts`, `meetings-api/src/media/ffmpegSlot.test.ts`, `meetings-api/src/jobs/runner.ts`, `meetings-api/src/jobs/runner.test.ts`, `meetings-api/src/jobs/handlers/prepareAudio.ts`, `meetings-api/src/media/probe.test.ts`
  - done when: `bun test src/media src/jobs` passes; a test shows two `prepare_audio` jobs never run ffmpeg concurrently, while a `transcribe` job waiting outside the slot does not block a `prepare_audio` claim
- [x] T97: [BE] Chirp 3 transcriber. Covers:
  - the splitter: silencedetect + segment copy under the slot, with `PIECE_MAX_MS` and word offsets as code constants;
  - per-part upload, `batchRecognize` (chirp_3, one locale, diarization, `gcsOutputConfig`), polling with backoff and deadline, bounded output read, `operations.delete`, and prefix cleanup at start and in `finally`;
  - result → `Phrase` with part offsets, `p<n>:<label>` speakers and word-run splitting, plus `partStartsMs`;
  - the § G-8 mapping, and hand-built REST fixtures;
  - deletion of `azureSpeech.ts` and its test.

  refs: AC-6.1, AC-6.2, AC-6.5, AC-6.7, AC-6.9, AC-13.2, AC-4.10, AC-4.12 — deps: T96, T98
  - touch: `meetings-api/src/ai/googleSpeech.ts`, `meetings-api/src/ai/googleSpeech.test.ts`, `meetings-api/src/media/split.ts`, `meetings-api/src/media/split.test.ts`, `meetings-api/src/media/split.real.test.ts`, `meetings-api/src/ai/transcriber.ts`, `meetings-api/src/ai/fakeTranscriber.ts`, `meetings-api/src/ai/segments.ts`, `meetings-api/src/ai/azureSpeech.ts`, `meetings-api/src/ai/azureSpeech.test.ts`, `meetings-api/test-fixtures/google-speech/*`
  - done when: `bun test src/ai src/media/split` passes with the § G-12 Speech cases, including "prefix deleted in finally on success and on each failure row". `split.real.test.ts` passes in the ffmpeg image (skips without ffmpeg). `git grep -i azure meetings-api/src` is empty
- [x] T99: [BE] Transcribe job + migration + transcript `parts`. Covers:
  - `transcriptPartStartsMs` (new migration), written in the existing commit and reset on retry;
  - `GET /meetings/:id/transcript` returns `parts`;
  - OpenAPI updated.

  refs: AC-6.1, AC-6.2, AC-6.7, AC-6.9 — deps: T97
  - touch: `meetings-api/prisma/schema.prisma`, `meetings-api/prisma/migrations/*_transcript_parts/*`, `meetings-api/src/jobs/handlers/transcribe.ts`, `meetings-api/src/jobs/handlers/transcribe.test.ts`, `meetings-api/src/transcript/transcript.routes.ts`, `meetings-api/src/transcript/transcript.test.ts`
  - done when: on `meetings_test`, `bun run db:deploy && bun test src/jobs/handlers/transcribe.test.ts src/transcript` passes. Cases: three parts → `parts` with three entries and labels s1..s5 across parts; a retry replaces parts; a text meeting gives `parts: []`; `noSpeech` gives `parts: []`
- [x] T100: [BE] Vertex Claude language model. Covers:
  - `@anthropic-ai/vertex-sdk` with a derived `baseURL`, explicit `authClient`, `maxRetries: 0` and a 60 s timeout;
  - forced `tool_choice`, with no `cache_control`, server tools, `advanced_ai_enabled` or betas;
  - the § G-8 mapping, and `languageModel.ts` wiring;
  - deletion of `bedrock.ts` and its test, and removal of `@aws-sdk/client-bedrock-runtime`.

  refs: AC-7.9, AC-7.10, AC-9.6, AC-4.10 — deps: T96
  - touch: `meetings-api/src/ai/vertexClaude.ts`, `meetings-api/src/ai/vertexClaude.test.ts`, `meetings-api/src/ai/languageModel.ts`, `meetings-api/src/ai/bedrock.ts`, `meetings-api/src/ai/bedrock.test.ts`, `meetings-api/package.json`, `meetings-api/bun.lock`
  - done when: `bun test src/ai/vertexClaude.test.ts src/ai/prompts` passes with the § G-12 Vertex cases, including the host assertion while `ANTHROPIC_VERTEX_BASE_URL` and `CLOUD_ML_REGION` are set in the test env
- [x] T101: [BE] Vertex startup checks N3 (`cacheConfig.disableCache`) and N4 (`fetchPublisherModelConfig`: 404 passes, `enabled`/`enableOtelLogging` true refuse, other errors refuse). Removes `checkBedrock` and `@aws-sdk/client-bedrock` — refs: AC-4.9 — deps: T96, T100
  - touch: `meetings-api/src/lib/startupChecks.ts`, `meetings-api/src/lib/startupChecks.test.ts`, `meetings-api/package.json`, `meetings-api/bun.lock`
  - done when: `bun test src/lib/startupChecks.test.ts` passes with each N3/N4 case. `bun run typecheck` passes. `git grep -i bedrock meetings-api/src meetings-api/package.json` is empty
- [x] T102: [BE] The deletion paths clear the transient prefix. `DELETE /meetings/:id` and `DELETE /meetings/:id/audio` delete `transcribe/<id>/` with the Railway prefix, before the DB change, and answer 503 with nothing changed on failure — refs: AC-4.5, AC-4.6, AC-4.12 — deps: T96
  - touch: `meetings-api/src/meetings/delete.routes.ts`, `meetings-api/src/meetings/delete.test.ts`, `meetings-api/src/audio/audio.routes.ts`, `meetings-api/src/audio/audio.test.ts`
  - done when: on `meetings_test`, `bun test src/meetings/delete.test.ts src/audio/audio.test.ts` passes. The fake transient storage records the delete before the cascade, and a failing fake gives 503 with the meeting and its audio intact
- [x] T103: [QE] Live eval on Vertex. `evals/run.ts --live` builds the Vertex model (explicit key or a WIF credential file; S2/S3 applied). The tests check the Vertex module is loaded only in the live branch. The meetings-api README covers env (§ G-7) and release (`MEETINGS_VERTEX_MODEL_ID`) — refs: AC-7.12, AC-9.7 — deps: T100
  - touch: `meetings-api/evals/run.ts`, `meetings-api/evals/eval.test.ts`, `meetings-api/README.md`
  - done when: `bun run eval` (fake) exits 0; `bun test evals/eval.test.ts` passes, including "refuses without the Vertex configuration, naming the variables and no values" and "location `global` refused"; `git grep -i bedrock meetings-api/evals meetings-api/README.md` is empty
- [ ] T104: [OPS] CI. `meetings-eval-live.yml` authenticates by GitHub OIDC WIF (`permissions: id-token: write`, `google-github-actions/auth` pinned by SHA) with the `MEETINGS_EVAL_*` vars of § G-7, keeping the skip-on-schedule / fail-on-dispatch behaviour. The `meetings-eval.yml` guard regex is updated — refs: AC-7.12, AC-9.7 — deps: T103
  - touch: `.github/workflows/meetings-eval-live.yml`, `.github/workflows/meetings-eval.yml`
  - done when: `actionlint` passes on both files; the PR job is green on the branch; a dispatched run without the vars fails naming them
- [x] T105: [OPS] env-doctor. `meetings-api` required keys and `SECRET_VARS` per § G-7; the seven removed names flagged as retired; the production template updated — refs: AC-4.9 — deps: T95
  - touch: `tools/env-doctor/manifest.ts`, `tools/env-doctor/templates/production/meetings-api.env`, `tools/env-doctor/check.test.ts`, `tools/env-doctor/retiredToken.test.ts`
  - done when: `mise run env:doctor` passes on the production templates. The env-doctor tests pass with new cases: missing `MEETINGS_GCP_SERVICE_ACCOUNT_KEY` reported; `AZURE_SPEECH_KEY` present → retired; the key's value never printed
- [x] T106: [OPS] `infra/meetings-gcs-transient-policy.sh` (apply/check the N2 rules on a GCS bucket via `gcloud storage`) and the infra README meetings section. The README covers:
  - the Google project and APIs;
  - Claude enablement in Model Garden;
  - `cacheConfig` disable;
  - the bucket;
  - the runtime and eval service accounts with custom roles and Speech-agent bucket bindings;
  - key creation, rotation and expiry;
  - the organization policies (§ G-5);
  - the **H1–H6 sign-off checklist** with owner and date fields;
  - the removal of every Azure/Bedrock step.

  refs: AC-4.4, AC-4.9 — deps: T96
  - touch: `infra/meetings-gcs-transient-policy.sh`, `infra/README.md`
  - done when: `bash -n infra/meetings-gcs-transient-policy.sh` passes; `--check` exits non-zero on a stubbed `gcloud` returning soft delete 7 d (a test harness with a fake `gcloud` on `PATH`); `git grep -i -E 'azure|bedrock' infra/README.md` is empty
- [x] T107: [QE] Google spike (release gate; replaces R2's Azure spike), in a sandbox project with synthetic it/en audio of 1 h and 3 h. It records the R2 measurements, sets `PIECE_MAX_MS` and word offsets in `googleSpeech.ts`/`split.ts`, and replaces the hand-built fixtures with scrubbed recorded ones. Outcome in a dated note under § G-3 of plan.md (via the orchestrator) — refs: AC-6.1, AC-6.2, AC-6.5 — deps: T97, T101, T106
  - touch: `meetings-api/scripts/spike-google-speech.ts`, `meetings-api/test-fixtures/google-speech/*`, `meetings-api/src/ai/googleSpeech.ts`, `meetings-api/src/media/split.ts`
  - done when: `bun test src/ai/googleSpeech.test.ts src/media/split.test.ts` passes on the recorded fixtures; the measured p95 latency and the chosen constants are recorded; a startup against the sandbox project passes N2–N4
- [x] T108: [FE] meetings-ui transcript parts. The info `Banner` and per-part dividers when `parts.length > 1`, en/it copy, types, and fakeApi fixtures with a three-part transcript — refs: AC-6.1, AC-6.2, AC-13.1 — deps: none (contract § G-11)
  - banner rule and dividers superseded 2026-11-05 by T122 (spec A7)
  - touch: `meetings-ui/src/components/transcript/TranscriptView.tsx`, `meetings-ui/src/components/transcript/TranscriptView.test.tsx`, `meetings-ui/src/strings/transcript.ts`, `meetings-ui/src/lib/types.ts`, `meetings-ui/src/test-support/fakeApi.ts`
  - done when: `cd meetings-ui && pnpm lint && pnpm build && pnpm test` passes. New component cases: one part → no banner, no divider; three parts → banner + two dividers with formatted times; `catalogGaps` parity holds
- [x] T109: [OPS] AGENTS.md: the meetings rows (structure, meetings-api bullet, data-residency section, `MEETINGS_AI_PROVIDER` note) name Google Cloud (Speech `eu`, Vertex `eu`, transient bucket); the 0061 line is marked superseded in part; 0069 and 0070 are added — refs: AC-4.9 — deps: none (after the ADRs exist)
  - touch: `AGENTS.md`
  - done when: `git grep -n -i -E 'bedrock|azure ai speech|westeurope' AGENTS.md` matches only the 0061 line's history note; `mise run env:doctor` still passes
- [x] T110: [OPS] Changesets for meetings-api and meetings-ui (the provider change and transcript parts) — refs: AC-10.5 — deps: T95–T108, T111, T112
  - touch: `.changeset/*.md`
  - done when: `mise run changeset:check` passes
- [x] T111: [BE] meetings-api consent notice version bump for the A6 disclosure: `CONSENT_NOTICE_VERSION` → `2026-11-05`; attestations already recorded keep their version (no re-consent) — refs: AC-4.1 — deps: none
  - touch: `meetings-api/src/meetings/consent.routes.ts`, `meetings-api/src/meetings/consent*.test.ts`
  - done when: on `meetings_test`, `bun test src/meetings` passes, asserting the new version on a fresh attestation and that a pre-existing attestation still reads its old version
- [x] T112: [FE] meetings-ui consent notice copy (en + it) discloses that the transcription provider may keep the transcription result for about 5 days (EU/CH, no training), version `2026-11-05` matching T111 — refs: AC-4.1 — deps: none
  - touch: `meetings-ui/src/strings/consent.ts`, `meetings-ui/src/components/**/Consent*.test.tsx`
  - done when: `cd meetings-ui && pnpm lint && pnpm build && pnpm test` passes; a test asserts the provider-retention statement in en and it and the version string; `catalogGaps` parity holds

## Amendment 2026-11-05 #2 — T107 drifts and spec A7 (plan § H-14)

> Re-synced 2026-11-05 from plan § H-14 (approved by the user 2026-11-05). T108's banner and dividers are superseded by T122.
> T125 (O14, real consented recordings) is a go-live gate: it is NOT a dependency of T92 (user decision 2026-11-05).
> T104 stays open until a CI run on the pushed branch proves it.
> Re-synced 2026-11-06 after the plan addendum (draft failure.code contract, AC-3.2, already implemented in T28/T30) — no task change.
> Re-synced 2026-11-05 for spec A8: per-part retries disabled (tries = 1), repetitions never flag a part, same-speaker duplicate rule within a part (overlap: removed unless joined to different speakers) and untimed repeated tails (follow-up commits on T115/T116). No new task; O15 tracks a different-audio retry.

- [x] T113: [BE] Overlapping parts: `chooseParts` (H-1), per-part output-seek stream copy (retires the segment muxer and `parts.csv`), silence pass on every recording with the speech-band filter, `splitAudio` returns `{parts {path,startMs,endMs}, silences, durationMs}` — refs: AC-6.2, AC-6.11, AC-6.14 — deps: none
  - touch: `meetings-api/src/media/split.ts`, `meetings-api/src/media/split.test.ts`, `meetings-api/src/media/split.real.test.ts`
  - done when: `bun test src/media/split` passes with cases "10 860 s → 22 parts, each ≤ 600 s, overlaps within [60, 120] s, edges in pauses when offered", "≤ 10 min → 1 part and a silence list"; `split.real.test.ts` (ffmpeg image) cuts a 75 s fixture with `PIECE_MAX_MS` 30 s and overlap 10 s and ffprobe durations match ± 40 ms
- [x] T114: [BE] `src/ai/words.ts` (word model, normalisation, effective times) and `src/ai/completeness.ts` (holes, credited sound, noise-marker excuse, repetition D1 detection, try ranking, final-gap subtraction and merge) — refs: AC-6.7, AC-6.11, AC-6.12, AC-6.13 — deps: none
  - touch: `meetings-api/src/ai/words.ts`, `meetings-api/src/ai/words.test.ts`, `meetings-api/src/ai/completeness.ts`, `meetings-api/src/ai/completeness.test.ts`
  - done when: `bun test src/ai/words.test.ts src/ai/completeness.test.ts` passes with the AC-6.7/6.11/6.12 rows of H-10 (each ranking tie level, a lone `[` excusing a hole, 600 ms credit, cross-boundary merge, neighbour coverage subtraction)
- [x] T115: [BE] `src/ai/stitch.ts`: D1 removal, D2 alignment and union, J0–J5 joins, segments split at gaps with `part`; `mapPhrases` keeps `part` on `DraftSegment` — refs: AC-6.2, AC-6.13, AC-6.14, AC-6.15, AC-6.17 — deps: T114
  - touch: `meetings-api/src/ai/stitch.ts`, `meetings-api/src/ai/stitch.test.ts`, `meetings-api/src/ai/segments.ts`, `meetings-api/src/ai/segments.test.ts`
  - done when: `bun test src/ai/stitch.test.ts src/ai/segments.test.ts` passes with the AC-6.13/6.14/6.15 rows of H-10 and the static "no `src/media` import, no audio field" check
- [x] T116: [BE] Google adapter per-part tries (H-4): per-try output prefix read and deleted at once, input deleted per part, try-2/3 errors settle on best, `SPEECH_MAX_INFLIGHT` semaphore and 30 s/15 s polling, `MAX_WORDS_PER_PART`, words → `completeness` → `stitch`; the outcome gains `parts {startMs,endMs}[]`, `gaps`, segment `part`; `speech_not_transcribed`; `transientKeys` patterns `out/<k>-<t>/`; `FakeTranscriber` scriptable gaps, parts and joined keys — refs: AC-4.12, AC-6.7, AC-6.9, AC-6.10, AC-6.11, AC-13.4, AC-4.10 — deps: T113, T114, T115
  - touch: `meetings-api/src/ai/googleSpeech.ts`, `meetings-api/src/ai/googleSpeech.test.ts`, `meetings-api/src/ai/transcriber.ts`, `meetings-api/src/ai/fakeTranscriber.ts`, `meetings-api/src/lib/google/transientStorage.ts`, `meetings-api/src/lib/google/transientStorage.test.ts`, `meetings-api/test-fixtures/google-speech/overlap-*.json`
  - done when: `bun test src/ai src/lib/google` passes with the AC-6.11 and AC-4.12 rows of H-10 (fake Speech scripted per try; fake transient storage records per-try and per-part deletions) and "at most 24 operations in flight across two concurrent transcribers"
- [x] T117: [BE] Migration `*_transcript_quality` (H-5: part ends, `segment.part`, `transcript_gap`, `speaker_label.defaultIndex`, `summary.transcriptGaps`); the transcribe commit writes them (replace, never append); `speech_not_transcribed` is permanent; transcript GET adds `parts[].endMs`, `segments[].part`, `speakers[].parts/joined`, `gaps`, `separateLabels`, and default index = key number; OpenAPI — refs: AC-6.2, AC-6.7, AC-6.12, AC-6.15, AC-6.16 — deps: T116
  - touch: `meetings-api/prisma/schema.prisma`, `meetings-api/prisma/migrations/*_transcript_quality/*`, `meetings-api/src/jobs/handlers/transcribe.ts`, `meetings-api/src/jobs/handlers/transcribe.test.ts`, `meetings-api/src/transcript/transcript.routes.ts`, `meetings-api/src/transcript/transcript.test.ts`
  - done when: on `meetings_test`, `bun run db:deploy && bun test src/jobs/handlers/transcribe.test.ts src/transcript` passes: gaps rows written and cascaded on delete; a retry replaces them; `separateLabels` true iff a key's lowest part > 1; legacy rows (part null) read as not joined; a `ready` meeting is not re-transcribed
- [x] T118: [BE] `POST /meetings/{id}/transcript/speakers/{key}/separate` (H-6) with row lock, name copy incl. `defaultIndex`; `speakerNamesFor` honours `defaultIndex` — refs: AC-6.16, AC-5.8, AC-5.11, AC-6.2 — deps: T117
  - touch: `meetings-api/src/transcript/transcript.routes.ts`, `meetings-api/src/transcript/separate.test.ts`, `meetings-api/src/meetings/promptSegments.ts`, `meetings-api/src/matrix.test.ts`
  - done when: on `meetings_test`, `bun test src/transcript/separate.test.ts src/matrix.test.ts` passes: the AC-6.16 row of H-10, and the route appears in the authorization matrix (creator 200, participant 403, frozen 403, stranger 404)
- [x] T119: [BE] Service-written caveats: the summarize job snapshots `transcriptGaps` and renders `NOT_FOUND_INCOMPLETE`; the ask route stores `possiblyIncomplete` and uses `NOT_IN_MEETING_INCOMPLETE`; summary and turn responses carry them — refs: AC-7.13, AC-9.9, AC-7.4 — deps: T117
  - touch: `meetings-api/src/jobs/handlers/summarize.ts`, `meetings-api/src/jobs/handlers/summarize.test.ts`, `meetings-api/src/ai/prompts/summary.ts`, `meetings-api/src/ai/prompts/summary.test.ts`, `meetings-api/src/ai/prompts/answer.ts`, `meetings-api/src/ai/prompts/answer.test.ts`, `meetings-api/src/summaries/summaries.routes.ts`, `meetings-api/src/summaries/summaries.test.ts`, `meetings-api/src/conversation/conversation.routes.ts`, `meetings-api/src/conversation/conversation.test.ts`
  - done when: on `meetings_test`, these tests pass with the AC-7.13/9.9 rows of H-10, including "regenerate carries the snapshot" and "a meeting without gaps returns `possiblyIncomplete: null`/false and the old fixed texts"
- [x] T120: [BE] Vertex unforced single tool (H-8): no `tool_choice`, no `thinking`; the acceptance rule; thinking blocks discarded unread; the `invalid_output` log line; recorded reply-shape fixtures (scrubbed, synthetic content) from the pinned model, including whether explicit `auto` + `disable_parallel_tool_use` is accepted (recorded, not adopted) — refs: AC-7.9, AC-9.6, AC-7.10, AC-13.4, AC-4.10 — deps: none (it changes only the adapter; the resample paths in `summarize.ts`/`conversation.routes.ts` stay as they are)
  - touch: `meetings-api/src/ai/vertexClaude.ts`, `meetings-api/src/ai/vertexClaude.test.ts`, `meetings-api/src/ai/languageModel.ts`, `meetings-api/test-fixtures/google-vertex/messages-*.json`, `meetings-api/test-fixtures/google-vertex/README.md`
  - done when: `bun test src/ai/vertexClaude.test.ts` passes with the AC-7.9/9.6 row of H-10, and `git grep -n "tool_choice\|thinking" meetings-api/src/ai/vertexClaude.ts` matches only comments
- [x] T121: [QE] Evals: new channels (plain-text reply, double call, other tool) in en/it; the availability tier; a `max_tokens`-stop assertion in the live run; a live run on the pinned model, twice, recorded in the PR — refs: AC-7.12, AC-9.7, AC-7.9, AC-9.6 — deps: T120
  - touch: `meetings-api/evals/assertions.ts`, `meetings-api/evals/types.ts`, `meetings-api/evals/fixtures/summary.en.ts`, `meetings-api/evals/fixtures/summary.it.ts`, `meetings-api/evals/fixtures/answer.en.ts`, `meetings-api/evals/fixtures/answer.it.ts`, `meetings-api/evals/run.ts`, `meetings-api/evals/eval.test.ts`
  - done when: `bun run eval` (fake) exits 0; `bun test evals/eval.test.ts` passes; the live run's summary (safety 0, availability ≤ 2, no `max_tokens`, first-sample tool-call rate) is in the PR description
- [x] T122: [FE] meetings-ui transcript: types, the notice with ranges and play controls, gap markers, the new parts-banner rule and copy, dividers by `segment.part`, the joined indication and "Separate by part" dialog, export with notice and markers, `speech_not_transcribed` copy, en/it — refs: AC-6.2, AC-6.6, AC-6.7, AC-6.12, AC-6.15, AC-6.16, AC-13.1 — deps: none (contract H-6)
  - touch: `meetings-ui/src/components/transcript/TranscriptView.tsx`, `meetings-ui/src/components/transcript/TranscriptView.test.tsx`, `meetings-ui/src/components/transcript/exportText.ts`, `meetings-ui/src/components/transcript/SpeakerRenameDialog.tsx`, `meetings-ui/src/components/transcript/SeparateSpeakerDialog.tsx`, `meetings-ui/src/components/transcript/Corrections.test.tsx`, `meetings-ui/src/strings/transcript.ts`, `meetings-ui/src/strings/meeting.ts`, `meetings-ui/src/lib/types.ts`, `meetings-ui/src/lib/meetingsApi.ts`, `meetings-ui/src/test-support/fakeApi.ts`
  - done when: `cd meetings-ui && pnpm lint && pnpm build && pnpm test` passes with new cases: no gaps → no notice; two gaps → notice and markers in place, no dismiss, no play after audio deletion; banner only with `separateLabels` and without the forbidden phrases; Separate shown only with `can.editTranscript`; the exported text starts with the notice; `catalogGaps` parity
- [x] T123: [FE] meetings-ui summary and answer caveat labels, the link to the notice, labels in copied text — refs: AC-7.13, AC-9.9, AC-7.11 — deps: T122 (shared `lib/types.ts`, `fakeApi.ts`)
  - touch: `meetings-ui/src/components/summaries/SummaryCard.tsx`, `meetings-ui/src/components/summaries/Summaries.test.tsx`, `meetings-ui/src/components/ask/Turn.tsx`, `meetings-ui/src/components/ask/Ask.test.tsx`, `meetings-ui/src/strings/summaries.ts`, `meetings-ui/src/strings/ask.ts`, `meetings-ui/src/lib/types.ts`, `meetings-ui/src/test-support/fakeApi.ts`
  - done when: `cd meetings-ui && pnpm lint && pnpm build && pnpm test` passes; the copied summary text contains the label and the ranges; the answer label links to `#meetings-transcript-incomplete`
- [x] T124: [QE] Spike regression (release gate): `--reference`, detector, retry, join and dedup report without content; records the overlap, hole and silence fixtures; the AC-6.17 replay test on them — refs: AC-6.11, AC-6.12, AC-6.14, AC-6.17 — deps: T116
  - touch: `meetings-api/scripts/spike-google-speech.ts`, `meetings-api/test-fixtures/google-speech/recorded-overlap-*.json`, `meetings-api/test-fixtures/google-speech/recorded-hole-*.json`, `meetings-api/test-fixtures/google-speech/README.md`, `meetings-api/src/ai/stitch.recorded.test.ts`
  - done when: `bun test src/ai/stitch.recorded.test.ts` passes (three silence lists, two audio files, identical joins); the spike's pass criteria of H-10 are met on the sandbox and recorded in a dated note under H-1 (via the orchestrator)
- [ ] T125: [QE] O14 measurement on consented recordings (QH-1): false-gap, missed-gap and false-join rates; bounds confirmed or changed; outcome in a dated note under H-3 (via the orchestrator). **Go-live gate.** — refs: AC-6.11, AC-6.13, AC-6.14, O14 — deps: T124
  - touch: `meetings-api/scripts/measure-transcript-quality.ts`
  - done when: the note records the three rates on ≥ 8 h, and zero false joins (any false join found is filed as a defect and fixed before go-live); any changed bound is a code constant with its test updated
- [x] T126: [OPS] ADRs via adr-writer: amend 0067 and 0070, new 0073, follow-up notes on 0062/0064/0069; AGENTS.md ADR lines — refs: AC-6.14, AC-6.11, AC-7.9 — deps: none (after plan approval)
  - touch: `docs/adr/0067-ai-output-structured-validated-plain-text.md`, `docs/adr/0070-meetings-transcript-parts-speaker-labels-per-part.md`, `docs/adr/0073-meetings-transcript-completeness-detect-retry-mark.md`, `docs/adr/0062-durable-job-runner-work-queued-state-derived.md`, `docs/adr/0064-meetings-api-reads-audio-bytes-third-reader.md`, `docs/adr/0069-meetings-ai-providers-google-cloud-eu.md`, `AGENTS.md`
  - done when: each file carries its amendment or note with the rejected alternatives of H-12; `git grep -n "0073" AGENTS.md` matches the ADR list
- [x] T127: [OPS] Changesets for meetings-api and meetings-ui (A7, D4) — refs: AC-10.5 — deps: T113–T123
  - touch: `.changeset/*.md`
  - done when: `mise run changeset:check` passes

- [ ] T92: [QE] All gates green, spec status → done:
  - `bun test` in meetings-api, auth, crm-api and notify-api;
  - `pnpm lint && pnpm build && pnpm test` in meetings-ui, shell, crm-ui and notify-ui;
  - `mise run ui:check`, `mise run shared:check`, `mise run env:doctor`, `mise run changeset:check`;
  - the full `pnpm e2e meetings-*`, and `bun run eval`;
  - the OWASP review (frontier tier) and the QE verdict recorded.

  Then `/wellforge:done` sets `spec.md` `status: done` — refs: AC-1.1, AC-1.2, AC-1.3, AC-1.4, AC-1.5, AC-1.6, AC-1.7, AC-1.8, AC-2.1, AC-2.2, AC-2.3, AC-2.4, AC-2.5, AC-2.6, AC-2.7, AC-2.8, AC-2.9, AC-2.10, AC-2.11, AC-3.1, AC-3.2, AC-3.3, AC-3.4, AC-3.5, AC-4.1, AC-4.2, AC-4.3, AC-4.4, AC-4.5, AC-4.6, AC-4.7, AC-4.8, AC-4.9, AC-4.10, AC-4.11, AC-4.12, AC-5.1, AC-5.2, AC-5.3, AC-5.4, AC-5.5, AC-5.6, AC-5.7, AC-5.8, AC-5.9, AC-5.10, AC-5.11, AC-5.12, AC-5.13, AC-6.1, AC-6.2, AC-6.3, AC-6.4, AC-6.5, AC-6.6, AC-6.7, AC-6.8, AC-6.9, AC-6.10, AC-6.11, AC-6.12, AC-6.13, AC-6.14, AC-6.15, AC-6.16, AC-6.17, AC-7.1, AC-7.2, AC-7.3, AC-7.4, AC-7.5, AC-7.6, AC-7.7, AC-7.8, AC-7.9, AC-7.10, AC-7.11, AC-7.12, AC-7.13, AC-8.1, AC-8.2, AC-8.3, AC-8.4, AC-8.5, AC-8.6, AC-8.7, AC-9.1, AC-9.2, AC-9.3, AC-9.4, AC-9.5, AC-9.6, AC-9.7, AC-9.8, AC-9.9, AC-10.1, AC-10.2, AC-10.3, AC-10.4, AC-10.5, AC-10.6, AC-10.7, AC-10.8, AC-11.1, AC-11.2, AC-11.3, AC-11.4, AC-11.5, AC-11.6, AC-11.7, AC-11.8, AC-11.9, AC-11.10, AC-12.1, AC-12.2, AC-12.3, AC-12.4, AC-12.5, AC-13.1, AC-13.2, AC-13.3, AC-13.4, AC-14.1, AC-14.2, AC-14.3, AC-14.4, AC-14.5, AC-14.6, AC-14.7, AC-14.8, AC-14.9, AC-14.10, AC-14.11 — deps: T43, T81, T82, T84, T85, T87, T88, T89, T90, T91, T95, T96, T97, T98, T99, T100, T101, T102, T103, T104, T105, T106, T107, T108, T109, T110, T111, T112, T113, T114, T115, T116, T117, T118, T119, T120, T121, T122, T123, T124, T126, T127
  - touch: `specs/021-meetings/spec.md`, `specs/021-meetings/tasks.md`
  - done when: every listed command exits 0, the review verdicts are recorded, and `/wellforge:done 021` accepts the transition

## Coverage (AC → tasks; T92 closes every AC and is not listed)

| AC | Tasks |
|---|---|
| AC-1.1 | T19, T21, T56, T88 |
| AC-1.2 | T19, T56 |
| AC-1.3 | T19, T56 |
| AC-1.4 | T2, T13, T19, T49, T76, T87 |
| AC-1.5 | T7, T19, T56 |
| AC-1.6 | T19, T56 |
| AC-1.7 | T21, T22, T58, T76 |
| AC-1.8 | T19, T58 |
| AC-2.1 | T26, T61, T63 |
| AC-2.2 | T45, T52, T64, T88 |
| AC-2.3 | T19, T58, T64 |
| AC-2.4 | T52, T62, T64 |
| AC-2.5 | T62, T64 |
| AC-2.6 | T27, T30, T63 |
| AC-2.7 | T27, T44, T64 |
| AC-2.8 | T93, T27, T63, T65, T89 |
| AC-2.9 | T93, T26, T63, T65, T89 |
| AC-2.10 | T50, T64, T89 |
| AC-2.11 | T26, T63, T64 |
| AC-3.1 | T28, T30, T44, T46, T66 |
| AC-3.2 | T14, T28, T46, T66 |
| AC-3.3 | T28, T66 |
| AC-3.4 | T29, T67 |
| AC-3.5 | T12, T19, T58 |
| AC-4.1 | T24, T61 |
| AC-4.2 | T61 |
| AC-4.3 | T24, T57 |
| AC-4.4 | T1, T14, T93, T30, T34, T70, T82 |
| AC-4.5 | T14, T34, T70 |
| AC-4.6 | T12, T25, T75, T90 |
| AC-4.7 | T25, T75, T90 |
| AC-4.8 | T18, T25, T42 |
| AC-4.9 | T11, T14, T35, T43, T81, T82, T85 |
| AC-4.10 | T10, T42 |
| AC-4.11 | T63, T89 |
| AC-5.1 | T4, T12, T24, T47, T60 |
| AC-5.2 | T18 |
| AC-5.3 | T18, T42, T54 |
| AC-5.4 | T24, T60 |
| AC-5.5 | T21, T22, T58 |
| AC-5.6 | T7, T21, T22, T88 |
| AC-5.7 | T7, T18, T22 |
| AC-5.8 | T93, T42 |
| AC-5.9 | T24 |
| AC-5.10 | T13, T24, T60 |
| AC-5.11 | T18, T93, T57 |
| AC-5.12 | T25, T75 |
| AC-5.13 | T18 |
| AC-6.1 | T29, T33, T45, T68 |
| AC-6.2 | T31, T33, T69 |
| AC-6.3 | T33, T69 |
| AC-6.4 | T68 |
| AC-6.5 | T34, T52, T70 |
| AC-6.6 | T68 |
| AC-6.7 | T31, T32, T57, T68 |
| AC-6.8 | T33, T40, T71 |
| AC-6.9 | T17, T32, T57 |
| AC-6.10 | T32, T57 |
| AC-7.1 | T40, T71 |
| AC-7.2 | T36, T71 |
| AC-7.3 | T12, T40, T71 |
| AC-7.4 | T40, T71 |
| AC-7.5 | T40, T94 |
| AC-7.6 | T94, T71 |
| AC-7.7 | T40, T72 |
| AC-7.8 | T40, T72 |
| AC-7.9 | T17, T94, T71 |
| AC-7.10 | T35, T36 |
| AC-7.11 | T40, T71 |
| AC-7.12 | T36, T83, T84 |
| AC-8.1 | T37, T74 |
| AC-8.2 | T38, T48, T74 |
| AC-8.3 | T38, T74 |
| AC-8.4 | T38, T74 |
| AC-8.5 | T37, T71 |
| AC-8.6 | T36, T37 |
| AC-8.7 | T38 |
| AC-9.1 | T41, T73 |
| AC-9.2 | T36 |
| AC-9.3 | T36, T41, T73 |
| AC-9.4 | T36 |
| AC-9.5 | T41, T73 |
| AC-9.6 | T41, T73 |
| AC-9.7 | T36, T83, T84 |
| AC-9.8 | T39, T41, T73 |
| AC-10.1 | T23, T49, T55, T87 |
| AC-10.2 | T23, T55 |
| AC-10.3 | T23, T55 |
| AC-10.4 | T42, T49, T54, T57, T87 |
| AC-10.5 | T2, T49, T55, T80, T87, T91 |
| AC-10.6 | T13, T93, T42, T54 |
| AC-10.7 | T55 |
| AC-10.8 | T2 |
| AC-11.1 | T11, T15, T85 |
| AC-11.2 | T21, T76, T77, T88 |
| AC-11.3 | T21, T76, T88 |
| AC-11.4 | T15, T21, T80, T86 |
| AC-11.5 | T7, T23, T55 |
| AC-11.6 | T19, T51, T56, T76, T77, T90 |
| AC-11.7 | T77 |
| AC-11.8 | T3, T6, T20, T22 |
| AC-11.9 | T20, T59 |
| AC-11.10 | T15 |
| AC-12.1 | T5, T24 |
| AC-12.2 | T32 |
| AC-12.3 | T16 |
| AC-12.4 | T3, T16 |
| AC-12.5 | T5, T16, T79 |
| AC-13.1 | T53 |
| AC-13.2 | T31, T32 |
| AC-13.3 | T45, T64, T89 |
| AC-13.4 | T39, T71 |
| AC-14.1 | T8, T76, T88 |
| AC-14.2 | T8, T9, T78 |
| AC-14.3 | T8 |
| AC-14.4 | T9, T78, T88 |
| AC-14.5 | T8, T22 |
| AC-14.6 | T8, T20, T25 |
| AC-14.7 | T8, T22 |
| AC-14.8 | T20, T59 |
| AC-14.9 | T8 |
| AC-14.10 | T20, T59 |
| AC-14.11 | T20 |

All 123 spec ACs are covered by at least one task besides T92. Every task cites at least one
AC. T80 (wiring), T85 (docs) and T91 (changesets) cite the ACs they make shippable rather
than ones they implement.

## Overlaps

Computed from every pair of `touch:` lists, globs included (the effective graph is `deps:` ∪
overlap). All 69 overlapping pairs are already ordered by a `deps:` path; **no unordered
overlap remains**. They fall into these groups:

**Scaffold-then-fill** (resolved by deps). The scaffold task creates stubs or placeholders;
every filler depends on it.
- T10's stub `*.routes.ts` glob, `env.ts` and `package.json` (T11, T19–T41 route tasks, T83);
- T17's `jobs/handlers/*.ts` stubs (T20, T30, T32, T94);
- T53's meetings-ui placeholders and `strings/*.ts` area modules (T54–T76).

**Same file, sequential edits** (resolved by deps):

| File | Order |
|---|---|
| `crm-api/src/index.ts` + `crm-api/src/matrix.test.ts` | T7 → T8 |
| `meetings-api/src/meetings/core.routes.ts` | T19 → T22 |
| `capture/recording.routes.ts` | T26 → T27 |
| `templates/templates.routes.ts` | T37 → T38 |
| `lib/startupChecks.ts` | T14 → T35 |
| `test-fixtures/media/*` | T28 → T30 |
| `shell/src/strings.ts` | T49 → T50 |
| `shell/vite.config.ts` + `shell/src/federation/*` | T49 → T51 |
| `strings/meeting.ts` | T57 → T59 |
| `strings/capture.ts` | T64 → T65 |
| `strings/transcript.ts` | T68 → T69 |
| `strings/summaries.ts` | T71 → T72 |

**Registry files** (serialised on purpose, each kept to as few tasks as possible):

| File | Owner |
|---|---|
| `operai-ui/src/index.ts` | chain T44 → T45 → T46 → T47 → T48 |
| `compose.yaml` | T1 only |
| `lerna.json`, `mise.toml` | T80 only |
| `tools/env-doctor/manifest.ts` | T81 only |
| `AGENTS.md` | T85 only |
| `scripts/check-shared-copies.ts` | T43 only |
| auth catalog/seed (`auth/src/authz/seed.ts`, `catalogs/*`) | T2 only |
| `shell/src/router.tsx` | T49 only |
| `shell/vercel.json` | T52 only |
| `.changeset/*.md` | T91 only |
| `specs/021-meetings/spec.md` | T92 only |

**Parallel by construction** (no overlap):
- the three auth tasks (T2/T3/T4) are separate files;
- crm-ui T47/T48 (library migration) vs T77/T78 (meetings section, activity link) are separate files;
- shell T79 (`ToastHost`, `lib/notifications.ts`) vs T49/T50 are separate files.

The FE track (T44–T79) needs no BE task: it tests against `fakeApi.ts` and the plan's
contracts. Only the e2e tasks (T86–T90) join the two tracks.

### Coverage additions (2026-11-05)

| AC | Added tasks |
|---|---|
| AC-4.1 | T111, T112 |
| AC-4.5 / AC-4.6 | T96, T102 |
| AC-4.9 | T95, T96, T101, T105, T106, T109 |
| AC-4.10 | T97, T100 |
| AC-4.12 | T96, T97, T102 |
| AC-6.1 / AC-6.2 | T97, T99, T107, T108 |
| AC-6.5 | T97, T107 |
| AC-6.7 / AC-6.9 | T97, T99 |
| AC-7.9 / AC-7.10 / AC-9.6 | T100 |
| AC-7.12 / AC-9.7 | T103, T104 |
| AC-13.2 | T97 |
