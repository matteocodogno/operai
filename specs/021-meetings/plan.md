---
spec: 021
status: approved
approved: 2026-11-04
---

# Plan: Meetings — record, transcribe, summarise and question meetings (specs/021)

Vendor facts cited here were read from the vendors' own documentation on 2026-11-04 (links
in § AI providers). Decisions that constrain later work are numbered **D-n** in the text and
listed under § ADR candidates with the paths they are expected to have.

## Architecture

```
                      ┌──────────── shell (:5173) ─────────────────────────────────────────┐
                      │ /meetings/$     gated (meetings:access) ──MF──► meetings-ui ./App   │
                      │ /my-meetings/$  UNGATED (any signed-in) ──MF──► meetings-ui ./MyMeetings
                      │ shell/extensions: HostExtension("meetings.hostMeetings")           │
                      │        └─ timeout + error boundary ──MF──► meetings-ui ./HostMeetings
                      └────────────────────────────────────────────────────────────────────┘
 crm-ui deal page ── <HostExtension name="meetings.hostMeetings" props={{hostApp:"crm",entityType:"deal",entityId}}/>

 meetings-ui ──apiFetch──► meetings-api (:8085, DB "meetings", worker in-process)
      │  presigned POST (chunks, uploads) / presigned GET (playback)      │
      └──────────────────────► EU bucket MEETINGS_S3_* ◄──────────────────┤ (reads bytes: D-7)
                                                                          ├─► auth  /authz/resolve (fail closed)
                                                                          │         /authz/users/identities (names: soft; gates: closed)
                                                                          │         /system/service-token
                                                                          ├─► crm-api POST /meeting-host/v1/resolve        (caller's JWT, fail closed)
                                                                          │           POST /system/meeting-host/v1/notices (service JWT, host-notices.send)
                                                                          ├─► notify-api POST /system/notifications (service JWT, notifications.push)
                                                                          ├─► Azure AI Speech fast transcription (EU region)
                                                                          └─► Amazon Bedrock, Claude, EU, data_retention_mode=none
```

### Shape (answers question 1) — D-1

- **New `meetings-api`** (Bun + Hono + `@hono/zod-openapi` + Prisma 7, own logical DB
  `meetings`, port **8085**, Railway EU West / Amsterdam, own EU bucket `MEETINGS_S3_*`). It is
  an authorization-enforcing resource server (ADR-0014): `jwtMiddleware` + `authzMiddleware`
  copied from crm-api. It differs from crm-api in one structural way: **reads of a meeting by
  its creator or an Operai participant do not depend on `auth`'s authorization endpoint**
  (AC-10.6). Three guard stacks, attached per route (never `router.use("*")`, crm-api's rule):

  | Stack | Middleware | Used by |
  |---|---|---|
  | `selfScoped` | JWT only; an *optional* authz resolve that never refuses (sets `capabilities: "unavailable"` on failure) | list My meetings, open a meeting, transcript, summaries, audio URL, own conversation (read/clear), delete own summary |
  | `capability(…)` | JWT + live `/authz/resolve` (fail closed → 503) + the named permission | everything that creates, generates, asks or edits |
  | `eraser` | JWT + live resolve + `meeting:erase` | the erase search screen |

  Visibility (creator / Operai participant / host-visible reader) is a record-level check in
  every route, after the stack. A host-visible reader is the only visibility class that needs
  `auth` and the host (both fail closed), so an `auth` outage leaves creators and participants
  reading and removes only host-granted visibility.
- **New `meetings-ui`** (Vite 8 + React 19 federated remote, port **5180**, `@operai/ui`,
  TanStack Router). Three exposed entries plus `./version` (ADR-0030):
  - `./App` — the gated tool at `/meetings/$` (list with New meeting + Templates, new-meeting
    form, capture page, meeting page, templates, erase screen for `meeting:erase` holders);
  - `./MyMeetings` — the UNGATED entry at the shell-owned `/my-meetings/$` (list + meeting
    page), reached from a new "My meetings" UserMenu link (ADR-0034/0045 shape: ungated route
    **and** self-scoped API reads are both required);
  - `./HostMeetings` — the panel a host embeds (D-3).

  The meeting page is one component used by both router entries; its controls follow the
  server's `can` flags, so a read-only participant sees no create/summarise/ask/edit control
  (AC-10.4). **Every deep link** (notifications, the CRM activity, host panel rows) points at
  `/my-meetings/m/<id>` because that route works for every visibility class; the gated tool's
  own list links to `/meetings/m/<id>` (same page).
- **Rejected:** meetings inside crm-api (Meetings must serve PM/HR hosts later and is not CRM
  data; AC-11.10 forbids it reading host data); one ungated entry with in-remote gating of the
  create screens (puts an auth guard in a remote, against ADR-0006, and loses the sidebar/
  last-tool behaviour of `TOOLS`); a shell-native My meetings screen (tool logic in the shell,
  against ADR-0009, the same reason ADR-0045 gives).

Predicted ADR: `docs/adr/0058-meetings-tool-shape-visibility-by-participation.md`.

### Host integration contract (answers question 2) — D-2 server half, D-3 UI half

**Registry (code, in `meetings-api/src/hosts/registry.ts`).** A host is data, never a branch
in a route:

```ts
interface HostDefinition {
  app: string                       // "crm"
  entityType: string                // "deal"
  baseUrl: string                   // from env (CRM_API_URL — Railway private DNS)
  labels: Record<'en' | 'it', {
    app: string                     // "CRM"
    entity: string                  // "Deal" | "Opportunità"
    visibilityHint: string          // G6: "and can see deal financials" | "e possono vedere i dati economici dell'opportunità"
    noticeFailed: string            // G7: "The deal's activity could not be added" | "Non è stato possibile aggiungere l'attività all'opportunità"
  }>
  offersHostVisible: boolean        // CRM: true
  hostVisibleRequirement: string    // documentation only: "deal:financials" (enforced by the host's answer)
  notices: boolean                  // CRM: true
  recommendedTemplates: string[]    // CRM deal: ["builtin:sales-discovery"]
  contract: 1
}
```

Production contains exactly `crm/deal` (AC-11.1). `MEETINGS_TEST_HOSTS` (JSON array, same
shape) adds test hosts and is **refused at startup when `NODE_ENV=production`** (exit 1).
`GET /hosts` serves the public part (app, entityType, labels incl. `visibilityHint` and
`noticeFailed`, offersHostVisible, recommendedTemplates) so the meeting screens render any host from data — that is what makes
AC-11.4 "no change to the meeting screens" true by construction.

**What a host implements (contract v1).** Two endpoints, both owned by the host:

1. `POST {baseUrl}/meeting-host/v1/resolve` — "may *this caller* open these entities?"
   - Authenticated with the **caller's own JWT, forwarded verbatim** (ADR-0035 model: no new
     secret; the host applies its own live authorization).
   - Body `{ entityType, ids: string[1..25] }`.
   - Answer `{ items: [{ id, state: "open" | "closed" | "missing", title?: string, href?: string, hostVisible?: boolean }] }`.
     `title`/`href` only when `open`; `hostVisible` = the caller holds what this host requires
     for host-visible meetings (CRM: `deal:financials`, AC-5.6).
   - A host answers `closed` (not 403) for a caller who may not open the entity, so one call
     answers a mixed batch. Any non-2xx, timeout (2 s) or malformed body = **unavailable**:
     meetings-api fails closed for every decision that grants (create with host, relink,
     host-visible read) and fails soft only for display labels (AC-10.3 → "CRM · deal").
2. `POST {baseUrl}/system/meeting-host/v1/notices` — the host notice, **only if `notices: true`**.
   - Authenticated with a **scoped service JWT** `sub="system:meetings-api"`,
     `aud=SERVICE_AUDIENCE`, scope **`host-notices.send`** (new, ADR-0044/0049 mechanism).
   - Body (strict; any other key is a 422 at the host):
     ```ts
     { noticeId: string /* uuid, idempotency */, seq: number /* monotonic per meeting */,
       event: "linked" | "changed" | "unlinked" | "deleted",
       meeting: { id: string, title: string | null, startsAt: string | null, creatorId: string },
       entity: { type: string, id: string } }
     ```
     `title`/`startsAt` are set for `linked`/`changed` and **null for `unlinked`/`deleted`**
     (so nothing with a title survives a deletion in the outbox, AC-4.6; amendment A3).
   - Answer `200 { applied: boolean }`; a notice with `seq ≤` the host's last seen seq for that
     meeting is `applied:false` (duplicates and reordering are harmless, AC-14.9). `422
     entity_not_found` is permanent.

**Delivery (meetings-api).** A `host_notice` outbox row is written in the same transaction
as the change, carrying only the fields above. After commit the route makes **one awaited
attempt** (5 s timeout) so its response can carry `hostNotice: { state: "failed", event }`.
Then:
- `linked`/`changed` — **manual** policy: a failure stays `failed`, is shown to the creator as
  a non-blocking warning with "Try again" (`POST /meetings/:id/host-notice/retry`), and is
  never retried silently (AC-11.9, AC-14.8). A newer notice for the same entity supersedes it.
- `unlinked`/`deleted` — **until delivered**: retried by the job runner with backoff (1 m,
  5 m, 30 m, 2 h, then every 6 h, loud log each time) because the removal must happen even
  with no creator to press a button (frozen, erased; AC-14.6).
- Delivered rows are deleted. `meetings-api` never calls a host for anything except these two
  endpoints (AC-11.10).

**CRM as the first host.** crm-api gains the two endpoints:
- `resolve`: JWT + live `/authz/resolve` (fail closed → 503). Without `crm:access`: existing
  ids → `closed`, others `missing`. With it: `open`, `title`, `href: "/crm/deals/<id>"`,
  `hostVisible: canSeeFinancials(c)`.
- `notices`: a `systemAuth` middleware (copied from notify-api; aud `SERVICE_AUDIENCE`, scope
  `host-notices.send`, sub allowlist `["system:meetings-api"]`) and an idempotent reconciler
  (US-14, § Data model crm-api).

**The UI half — a federated panel loaded through the shell (D-3).** meetings-ui exposes
`./HostMeetings`, props `{ hostApp, entityType, entityId }` — three strings, nothing else.
The shell gains a new expose **`./extensions`**:

```ts
// shell/src/lib/extensions.tsx  (exposed as `shell/extensions`)
type ExtensionProps = { 'meetings.hostMeetings': { hostApp: string; entityType: string; entityId: string } }
export function HostExtension<K extends keyof ExtensionProps>(p: {
  name: K; props: ExtensionProps[K]; fallback: ReactNode; loading?: ReactNode }): JSX.Element
// loads import('meetings/HostMeetings') raced against 5 s; a rejection, a timeout, a missing
// export or a render-time throw (error boundary) all render `fallback` — never throw (ADR-0030).
```

crm-ui imports `shell/extensions` **dynamically** (`import('shell/extensions').catch(() => null)`)
so a crm-ui running against a shell that predates the expose renders its own fallback.
The panel:
- lists `GET /hosts/crm/deal/:id/meetings` (AC-11.2), and renders its own "Meetings are
  unavailable" state when meetings-api fails (AC-11.6);
- shows "Start meeting" only when `usePermissions()` includes `meetings` (AC-1.4);
- navigates with `navigateSuite('/meetings/new?hostApp=crm&hostType=deal&hostId=<id>')`;
- shows **"Link an existing meeting"** under the same condition (amendment G2). It opens a
  dialog listing `GET /hosts/:app/:type/:id/linkable-meetings`: the caller's **own** meetings
  as creator, not frozen, not already linked to this entity (standalone ones and ones linked
  elsewhere, so this also relinks, AC-1.7/AC-14.7). Picking one calls the existing
  `PATCH /meetings/:id { host }` with this entity's host reference, which resolves the entity
  as the caller exactly as starting does (AC-1.5/AC-11.6). There is no host-side search API:
  the host contract (two endpoints) is unchanged. **Unlink** stays on the meeting page
  (Edit details → Remove link).

The new-meeting page asks meetings-api for the host entity (`GET /hosts/:app/:type/:id`,
resolved as the caller), so the title prefill and the "Deal · <title>" label come from the
host's answer, not from a query string (AC-1.1).

**Why a federated component here when ADR-0050 rejected them for the design system.**
ADR-0050's option D was rejected for *primitives used everywhere*. Its four reasons were:
- every remote's types become hand-written;
- every unit test must stub every component;
- Storybook cannot use the federation runtime;
- a shell deploy changes every remote's UI without the remote being rebuilt.

The panel is the opposite case:
- it is one coarse, domain-owned widget with one three-string prop type, declared once in
  `shell/extensions`;
- a host's tests stub one module, as they already stub `shell/session`;
- it has no Storybook role;
- changing it without rebuilding the host is the goal: Meetings owns how its meetings are
  listed, exactly as it owns its `./App`.

What does carry over from ADR-0050 is a runtime failure surface. That is why the panel is
wrapped in a timeout and an error boundary, and why each host keeps its own fallback copy.

**Rejected alternatives (D-3):**
- *Host-owned UI calling meetings-api.* Every host would re-implement the list, the status
  map, the Italian/English copy and the permission rules, so N hosts would need N redeploys
  per contract change. The host would also have to know Meetings' domain, which inverts
  US-11.
- *Navigation only* (a link to `/meetings?host=…` and no list on the deal). This fails
  AC-11.2.
- *crm-ui declaring `meetings` as its own MF remote.* Every host would have to replicate the
  shell's runtime remote-URL resolution (`runtimeRemotes.ts`), and composition belongs to the
  shell (ADR-0006).
- *An iframe.* It needs a second session bootstrap and breaks ADR-0001.

Predicted ADRs: `docs/adr/0059-meeting-host-contract-resolve-and-notices.md`,
`docs/adr/0060-host-extension-federated-panel-through-the-shell.md`.

**Proved generically by the fake host** (`meetings-api/src/test-support/fakeHost.ts`):
- a `Bun.serve` that implements both endpoints over an in-memory entity table;
- it records every notice and can be told to answer `closed`/`missing`/`503`/slowly;
- two test hosts are registered: `testhost/widget` (notices on, host-visible offered) and
  `quiethost/gadget` (notices off).

The CRM and the test hosts run through the **same** HTTP adapter (`hosts/client.ts`); there is
no CRM-specific code path in meetings-api.

### Browser capture (answers question 3) — D-4

- **Recorder** (`meetings-ui/src/capture/`): a module-level `RecordingSession` controller (not
  a component, so a confirmed in-app navigation can still flush) over `MediaRecorder`:
  - `audio/webm;codecs=opus` where `isTypeSupported`, else `audio/mp4` (Safari);
  - 32 kbit/s mono (3 h ≈ 43 MB);
  - `timeslice` **10 s**.

  Each chunk is uploaded as soon as it is emitted. A tab that crashes while connected loses
  at most the chunk being recorded plus the one in flight, ≤ 20 s (AC-2.8).
- **Mixing** (AC-2.4/2.5): the microphone (`echoCancellation`, `noiseSuppression` on) and, for
  an `online` meeting where offered, the audio track of `getDisplayMedia({ video: true,
  audio: true })`. Both go through `AudioContext` → `MediaStreamAudioDestinationNode` →
  `MediaRecorder`. The display video track is kept alive but never routed, so no image is
  captured.
  - **Capability matrix** (`capture/capabilities.ts`, unit-tested with a stubbed
    `navigator`): Chromium (Chrome, Edge) with `getDisplayMedia` → "microphone + tab audio";
    Firefox and Safari → "microphone only", with the AC-2.4 warning and a recommendation to
    upload instead.
  - A shared stream with no audio track, or a display track that ends, shows the AC-2.5
    message; the microphone node keeps feeding the recorder.
- **Chunk protocol.** Each chunk is written to `meetings/<id>/chunks/<seq 000000>` through a
  presigned POST (ADR-0016): 1 B to 8 MiB, the key fixed server-side, the policy valid
  5 minutes.
  - The client always holds the policy for the *next* seq: `recording/start` returns the one
    for seq 0, and each `confirm` returns the one for seq + 1.
  - So per chunk the client makes one bucket POST and one confirm.
  - Every request carries the `sessionId`.
- **Liveness and `interrupted`** (AC-2.8, derived on read). `recording_session` stores
  `lastChunkAt` and `lastBeatAt`. While paused, or while chunks are queued offline, the
  client sends `POST …/recording/heartbeat` every 30 s. Heartbeats and chunk confirms carry
  `capturedMs`, the total audio the tab has captured so far, saved or not (amendment G3).
  A meeting in `recording` whose
  `max(lastChunkAt, lastBeatAt)` is older than 2 minutes **reads** `interrupted`. No writer
  changes status by time (amendment A1 covers pause).
  - The same session may keep uploading after a gap: AC-2.9 says reconnection resumes saving.
  - A second `recording/start` while a session is live, or while the meeting holds chunks,
    is a 409 `recording_elsewhere` / `interrupted` (AC-2.11).
- **Offline** (AC-2.9): chunks wait in an **in-memory** queue with exponential backoff, and
  the indicator reads "Audio not yet saved". Nothing is ever written to IndexedDB,
  localStorage, sessionStorage or CacheStorage (AC-4.11). The cost of that choice is that
  audio captured *while offline* survives only while the tab lives (amendment A2). AC-2.9's
  "the creator is told how much" comes from `recording.lostMs` = `capturedMs` (last reported)
  − Σ stored chunk `durationMs`, floored at 0, on the latest session. It is a **lower bound**
  (audio captured after the last heartbeat is unknown), so the UI says "at least …". It is
  `null` when no `capturedMs` was ever reported, and the UI then shows the fallback sentence
  ("Some audio recorded while offline may have been lost").
- **Stop** (AC-2.7): `recorder.stop()` flushes the last chunk. The client uploads everything
  queued, then calls `recording/stop { lastSeq }`. The server answers 409 `chunks_missing
  { missing: [seq] }` until 0..lastSeq are all stored; then the meeting moves to `processing`.
  The screen shows "Saving n of m" until then.
- **Limits** (AC-2.11): the client warns at 2 h 50 and stops itself at 3 h. The server sums
  the client-reported `durationMs` (each ≤ 15 s) and refuses chunks past 3 h + 60 s with 409
  `duration_limit`.
- **Leaving** (AC-2.10):
  - A `beforeunload` prompt is active while recording or while chunks are unsaved.
  - In-app navigation goes through a new `shell/session` seam,
    `registerNavigationBlocker(shouldBlock, message)`, which the shell router honours with
    `useBlocker`. Feature-detected; a shell without it gets `beforeunload` only.
  - A confirmed in-app leave stops and saves, like Stop. A closed tab follows the
    `interrupted` path.
- **Upload** (US-3): `POST …/upload` mints one presigned POST:
  - key `meetings/<id>/upload/<uuid>`, ≤ 500 MiB, an allowlist of audio/video content types,
    valid 30 minutes;
  - the client pre-checks type and size and reads the duration from `loadedmetadata`;
  - the upload is an XHR with progress; a failure is retried by the user (AC-3.3).
  - `upload/confirm` HEADs the object, then runs **`ffprobe` synchronously** (≤ 30 s, over a
    60 s presigned GET with `-protocol_whitelist https,tls,tcp`). It checks that the demuxer
    is on the allowlist (mov/mp4/m4a, matroska/webm, ogg, wav, mp3, aac, flac), that there is
    an audio stream, and that the duration is ≤ 3 h.
  - On a pass the meeting moves to `processing`.
  - On a failure the object is deleted and the meeting stays `draft` with 422
    `upload_rejected { reason: unsupported_type | too_large | too_long | no_audio }`
    (AC-3.2).
  - Resumable multipart upload is rejected for v1: simplicity, and a retry is acceptable
    under AC-3.3.

### Processing, audio normalisation and the job runner (answers questions 3 and 4) — D-6 job runner, D-7 byte reads

- **Normalisation (where ffmpeg runs).** `ffmpeg`/`ffprobe` (Debian package pinned in
  meetings-api's Dockerfile) run **inside meetings-api** on Railway EU. The `prepare_audio`
  job:
  1. streams the chunks, or the uploaded original, to a per-job temp dir;
  2. runs `ffmpeg -protocol_whitelist file,pipe -i in -vn -sn -dn -ac 1 -ar 16000 -c:a libopus -b:a 32k audio.ogg`;
  3. puts `meetings/<id>/audio.ogg`;
  4. deletes the chunks or the original;
  5. removes the temp dir in `finally`.

  Video never leaves this step (AC-3.1), and the process runs non-root with a 20-minute
  ffmpeg timeout.
  - **Rejected:** ffmpeg.wasm in the browser (500 MiB in tab memory, slow, and no help for
    recordings); a third-party media service (one more processor for personal data); sending
    raw uploads to the transcriber (video bytes would leave our boundary, and the
    transcriber's size limits would apply to video).
  - This makes meetings-api the **third service that reads object bytes** (refund-api
    ADR-0043, crm-api ADR-0057): exactly ADR-0057's escalation trigger. The reads are
    bounded: ≤ 500 MiB to disk, never into memory; chunks ≤ 3 h at 32 kbit/s; audio.ogg
    ≤ ~45 MB.

  Predicted ADR `docs/adr/0064-meetings-api-reads-audio-bytes-third-reader.md`.
- **Jobs** (`meeting_job` table) — D-6. Kinds: `prepare_audio`, `transcribe`, `summarize`,
  `deliver_host_notice`.
  - A route enqueues in its own transaction and `NOTIFY meetings_jobs`.
  - A worker loop **inside the meetings-api process** (enabled by `MEETINGS_WORKER=on`) wakes
    on `LISTEN` or on a 30 s idle poll of its *own* queue.
  - It claims with `SELECT … FOR UPDATE SKIP LOCKED` where `state='queued' AND runAfter<=now()`
    **or** `state='running' AND leaseUntil<now()` (a job whose process died).
  - Lease 2 minutes, heartbeated every 30 s. At most 2 concurrent jobs per process, only one
    of them ffmpeg.
  - Every step is idempotent, and each result is committed in one transaction that re-checks
    the target row still exists and the job's `attemptId` still matches.
  - Retries: 3 attempts for transient provider errors (429/5xx/timeout), backoff 30 s → 2 m →
    10 m; permanent errors fail at once.
  - On SIGTERM the worker stops claiming and lets running work finish within Railway's grace
    period; anything cut off is re-claimed when its lease expires.

  **The distinction from ADR-0013, stated plainly.** ADR-0013 forbids a sweep that *writes
  lifecycle state by time*. The runner never does that: it only executes work a user asked
  for, and it never scans for "expired" things. Every time-based state stays derived on read:
  - `interrupted`;
  - audio expired;
  - frozen;
  - a stale summary;
  - an answer stuck `pending` for more than 2 minutes, which reads `failed`;
  - a summary `generating` for more than 10 minutes, which reads `failed` with Retry;
  - the rate-limit window.

  **Rejected:**
  - synchronous processing in the request (3 h of audio takes minutes, a deploy loses it);
  - a fire-and-forget promise with no row (lost on restart, nothing to retry, AC-6.9 cannot
    show `failed`);
  - Redis/BullMQ or SQS (a new store and new infrastructure for a queue Postgres already
    gives);
  - a Railway cron (a time-driven sweep, the exact thing ADR-0013 forbids, plus latency);
  - kicking work lazily on read only (nobody reading = never transcribed, and no AC-12.2
    notification).

  **Escalation:** split the worker into its own Railway service (`MEETINGS_WORKER=only` /
  `off`, same image) when ffmpeg affects API p95 or there are routinely more than 2 queued
  jobs.

  Predicted ADR `docs/adr/0062-durable-job-runner-work-queued-state-derived.md`.
- **Processing-time targets** (the spec leaves them to the plan; measured from content-free
  job timestamps):

  | Step | Target (p95) |
  |---|---|
  | Stop → `processing` once the last chunk is saved | ≤ 10 s |
  | `processing` → `ready` (prepare + transcribe) | ≤ 3 min + 0.2 × audio duration (1 h → 15 min; 3 h → 39 min) |
  | Upload confirm (probe) | ≤ 30 s |
  | Summary `generating` → `ready` | ≤ 90 s |
  | Answer to a question | ≤ 25 s (synchronous, 60 s hard timeout) |

  These are budgets for alerting and the week-1 spike (R2), not ACs.

### AI providers and residency (answers question 4) — D-5

> **Superseded in part (2026-11-05).** The provider choice below (Azure AI Speech, Amazon Bedrock) and
> its startup checks are replaced by § Amendment 2026-11-05 (provider change: Google Cloud) at the end of
> this plan. The hard constraint, the "verify at startup, unreadable = refuse" posture and the two
> interfaces stay. The table is kept as the record of what was compared on 2026-11-04.

Hard constraint: processing in the EU or Switzerland, contractual no-retention, no training,
diarization, Italian and English.

| Option | Residency | Retention / training | Fit | Verdict |
|---|---|---|---|---|
| **Azure AI Speech — fast transcription** (sync REST) | EU regions listed for fast transcription: francecentral, germanywestcentral, italynorth, northeurope, swedencentral, westeurope. **Not** Switzerland North (batch only there) [1] | "When doing … fast transcription … Microsoft does not retain or store the data" [2]; Azure does not train on customer data | Diarization 2–35 speakers on mono, < 5 h and < 500 MB, WebM and OGG/OPUS accepted, `it-IT` / `en-US` [3] | **Transcription: recommended**, region `westeurope` (nearest to Railway Amsterdam) |
| Mistral Voxtral Mini Transcribe V2 | EU by default, but "temporarily transferred outside the EU" to listed subprocessors depending on the feature [5] | Training opt-out needed on pay-as-you-go; ZDR "available only with pay-as-you-go and only for stateless API calls" [6] | Diarization, Italian + English [4] | Transcription **fallback** once ZDR is on and the subprocessor list is checked (O3) |
| AWS Transcribe (eu-central-1/2) | EU/CH | AI-services content may be used to improve the service unless an Organizations opt-out policy is set; input staged in S3 | Diarization, it/en | Rejected: more moving parts, retention depends on an org policy |
| Self-hosted Whisper + pyannote on Railway | EU | Ours | Needs GPUs our Railway setup does not have; CPU is far slower than real time for 3 h | Rejected (ops, latency) |
| **Claude on Amazon Bedrock**, EU | Region `eu-central-2` (Zurich) in-region when the pinned model is on-demand there, otherwise the EU geographic inference profile. AWS warns: "don't rely on the geographic prefix … verify all destination Regions" [8] | Per-region `data_retention_mode: none` = "No request or response data is written to durable storage by AWS or shared with the model provider", and a model that requires retention is **blocked** rather than silently retained [7]. Example: Claude Fable 5/5.1 require `aws_review` (up to 30 days of retention) and are therefore excluded; Claude Opus 4.8 allows `none` [7] | Long context (one 3 h meeting ≈ 50 k tokens), forced tool-use output | **LLM: recommended** |
| Azure OpenAI (DataZone EU or regional Standard) | EU member states for DataZone EU [9] | No training; abuse monitoring may store flagged prompts for human review unless the customer is approved for *modified abuse monitoring* ("managed customers may apply"), verifiable as `ContentLogging=false` [9] | Good | LLM **fallback**, only after approval. It keeps a single vendor if the AWS DPA is refused |
| Anthropic Claude API (first-party) | `inference_geo` is only `"global"` or `"us"`; workspace geo is only `"us"` [10] | — | — | **Not eligible** (verified, not assumed) |

**Recommendation:**
- transcription: Azure AI Speech fast transcription in `westeurope`, one locale per meeting
  (`it-IT` / `en-US`, never auto-detect, AC-13.2), diarization on with `maxSpeakers` =
  clamp(participants + 1, 2, 35);
- LLM: Claude on Bedrock EU with the account/region retention mode `none`, and a model id
  pinned in env.

**Fallbacks:** Voxtral (transcription) and Azure OpenAI with modified abuse monitoring (LLM),
each behind the same interface.

**Left for O3** (data-protection lead):
- the controller entity;
- the Microsoft and AWS DPAs, and whether the product-terms statements above count as the
  *contractual* no-retention the spec requires;
- a transfer-impact note for US-parented processors operating in EU regions;
- the Mistral subprocessor list if the fallback is ever used.

**Enforced at startup — AC-4.9.** `src/lib/residency.ts` refuses to start (exit 1) when any
of these fails:
- `MEETINGS_S3_*` EU residency, the existing `checkEuResidency`;
- `AZURE_SPEECH_REGION` must be in the EU/CH allowlist and match the endpoint host;
- `BEDROCK_REGION` must be in `{eu-central-1, eu-central-2, eu-west-1, eu-west-3, eu-north-1, eu-south-1, eu-south-2}` (London, eu-west-2, is not EU);
- when `BEDROCK_MODEL_ID` is an inference profile, `GetInferenceProfile` is called and every
  destination Region must be in that allowlist;
- the Bedrock data-retention configuration must read `none` in the home Region **and in
  every destination Region of the inference profile** (`bedrock:GetAccountDataRetention` in
  each); if any of them cannot be read, start is refused (amendment 2026-11-05);
- a fake provider is accepted only when `NODE_ENV !== "production"`.

Interfaces `Transcriber.transcribe(audio, locale, maxSpeakers)` and
`LanguageModel.complete(request, outputSchema)` have one real implementation each and a fake.

Predicted ADR `docs/adr/0061-meetings-ai-providers-eu-zero-retention.md`.

Sources:
- [1] https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions (region table, "Fast transcription" column)
- [2] https://learn.microsoft.com/en-us/azure/ai-foundry/responsible-ai/speech-service/speech-to-text/data-privacy-security ("No data trace")
- [3] https://learn.microsoft.com/en-us/azure/ai-services/speech-service/fast-transcription-create
- [4] https://docs.mistral.ai/capabilities/audio_transcription
- [5] help.mistral.ai "Where do you store my data"
- [6] help.mistral.ai "Can I activate Zero Data Retention (ZDR)?"
- [7] https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html
- [8] https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html
- [9] https://learn.microsoft.com/en-us/azure/ai-foundry/responsible-ai/openai/data-privacy
- [10] https://platform.claude.com/docs/en/build-with-claude/data-residency

### Summaries and ask-the-meeting (answers question 5) — D-8

- **Whole transcript in context, no retrieval.** The sizes are bounded:
  - a 3 h meeting ≈ 27 k words ≈ 50 k tokens;
  - a 200,000-character text meeting ≈ 60 k tokens.

  Retrieval (embeddings + a vector store) is rejected for three reasons:
  - it adds a processor and a second copy of the content (residency and deletion get harder);
  - it answers "what were the action items" worse than reading the whole meeting;
  - it buys nothing at this size.

  Follow-ups send the last 10 turns (AC-9.4). Prompt caching is an optimisation, used only if
  the provider confirms it is compatible with `none` retention.
- **Prompt layout.**
  - A fixed English system prompt sets the task, the output language and the rule that
    everything inside the transcript block is quoted data, never instructions.
  - The template's section instructions come next, length-bounded (≤ 500 per section, ≤ 2,000
    general).
  - Then `<transcript>` with one line per segment, `[S<ordinal> hh:mm:ss <speaker label>] text`.
    For a text meeting it is one line per passage (paragraph, split at ~1,000 characters),
    with no time or speaker.
  - Angle brackets and the `[S` marker are escaped inside segment text, so a speaker cannot
    close the block or forge a segment header.
- **Structured output** through forced tool use. The single "tool" is the output schema;
  there is no function that reaches anything, so there is no capability to act (AC-7.10).
  - Summary: `{ sections: [{ index, body ≤ 8,000, notDiscussed }] }`. The server checks that
    every index 0..n−1 appears exactly once, renders the **headings itself** from the
    template snapshot (built-in headings in the output language, AC-8.6), and writes the
    localised "Not discussed" (AC-7.2). Injected text can therefore change a section's prose
    but never the template's shape (AC-7.12).
  - Answer: `{ answer ≤ 4,000, citations: string[] ≤ 10, notInMeeting }`. The server keeps
    only citations that exist in this meeting. An answer with no valid citation is turned
    into the "the meeting does not contain this" answer, so no answer goes uncited (AC-9.3,
    AC-9.6). The answer is in the question's language (AC-9.1).
  - Invalid output → one retry → `failed`. Partial text is never stored as `ready` (AC-7.9).
- **Rendering:** plain text with line breaks, no Markdown links or images. Injected text
  cannot exfiltrate through an image URL, and React escapes the rest.
- **Testing the injection defence:**
  - Unit tests: the fake LLM returns hostile outputs (extra sections, renamed headings, prose
    claiming to be the system, citations that do not exist, a URL); the pipeline must reject
    or neutralise each one.
  - Evals (`meetings-api/evals/`, `bun run eval`, against the configured real EU provider):
    synthetic Italian and English transcripts with planted instructions ("ignore your
    instructions and …", "ignora le istruzioni …", a fake `</transcript><system>` block, a
    request to answer about something else, to switch language, to print a canary token or a
    URL). Assertions are deterministic:
    - the output is schema-valid;
    - every section is present;
    - the canary does not appear as a section body or as the answer;
    - an off-scope injected question comes back `notInMeeting`;
    - no URL appears that is not in the transcript;
    - the output language is the requested one.
  - The evals are a **release gate and a model-change gate**: changing `BEDROCK_MODEL_ID`
    requires a green eval run recorded in the PR. They run nightly in CI with a dedicated
    key; the content is synthetic, never personal.

Predicted ADR `docs/adr/0067-ai-output-structured-validated-plain-text.md` (the suite's first
LLM feature; ReviewAI/ProposAI will inherit it).

### Authorization (answers question 6)

- **Catalog** `meetings` (`auth/src/authz/catalogs/meetings.ts`), all unconditioned:
  `meetings:access`, `template:manage`, `meeting:erase`.
- **Seed** (`seedMeetingsCatalog`, `seedMeetingsGrants`):
  - `employee` → `meetings:access`, the **first default grant on `employee`**, a departure
    from specs/004's "employees get no default grants", forced by AC-10.8 (D-10);
  - `admin` → `meetings:access` via `ALL_APP_IDS`, plus `template:manage` and
    `meeting:erase`;
  - nothing else.
- **Who can open a meeting** (`visibility.ts`; anything else is 404, byte-identical to a
  nonexistent id, AC-5.3):
  - `creator`: `creatorUserId = sub`;
  - `participant`: a `meeting_participant` row with `userId = sub`;
  - `hostReader`: `hostVisible` AND the caller holds `meetings:access` (live, fail closed)
    AND the host's resolve says `state=open` AND `hostVisible=true` for this caller (live,
    fail closed, no cache, so a change bites on the next request, AC-5.5/5.7).

  No role ever grants reading. `meeting:erase` is checked only on the erase routes, which
  return no content (AC-4.7/4.8).
- **Frozen** (AC-5.11–5.13). Derived from the creator's live identity
  (`POST /authz/users/identities`, status `deleted`):
  - for display the lookup fails soft (`frozen: null` = unknown);
  - every creator control fails **closed**: 503 if the lookup fails, 403 `frozen` if the
    creator is deactivated. The one exception is the three high-frequency recording routes
    (chunk confirm, upload-url re-mint, heartbeat), which skip the lookup; the residual this
    accepts is stated in amendment 2026-11-05 #2.

  No caching: reactivation restores control on the next request.
- **Action matrix** (403 codes where the caller can open the meeting, AC-5.8):

  | Action | Needs |
  |---|---|
  | open, read transcript/summaries/consent/participants, audio URL, copy/download | visibility |
  | own conversation: read, clear | visibility |
  | delete a summary | visibility + (author ∨ creator) (AC-7.8; no capability: removing content is never gated) |
  | edit own summary (If-Match) | visibility + author or creator + `meetings:access` (frozen allowed for authors) |
  | generate/regenerate/retry summary, ask, retry answer | visibility + `meetings:access` + `ready` + speech + rate limit (frozen allowed) |
  | edit metadata, participants, host link, host-visible, consent, record, upload, text, transcript/speaker edits, retry processing, delete audio, retry host notice | creator + not frozen + `meetings:access` → else `creator_only` / `frozen` / `meetings_access_required` |
  | delete meeting | (creator + not frozen) **or** `meeting:erase`; the creator path needs no capability (deleting your own data must not depend on a grant) |
  | create meeting, templates | `meetings:access`; shared templates need `template:manage` |

  A creator who no longer holds `meetings:access` keeps read access and can delete their
  meeting or its recording, nothing else (amendment A4).
- **AC-10.6.** The `selfScoped` stack never refuses for want of `auth`. The meeting view
  carries `capabilities: "resolved" | "unavailable"`, and the UI hides capability controls
  and shows the suite's "Authorization service unavailable" banner. Capability routes answer
  503.
- **User directory** for the participant picker. `auth GET /authz/users/directory` adds
  `meetings:access` to `DIRECTORY_GATE_PERMISSIONS`. That is ADR-0047's escalation trigger,
  third consumer after ADR-0053, and since every employee holds `meetings:access` the
  directory (name, email, entity) becomes visible to every employee. Participants are
  re-validated server-side as active through `/authz/users/identities` (fail closed, 503).
  The picker calls the directory **without** ADR-0055's `?appId=` filter (amendment G9): a
  participant needs no tool grant (AC-10.4), so every active user must be pickable.
  Predicted ADR `docs/adr/0066-user-directory-gate-meetings-access.md`.
- **UI permission hints** (amendment G5). meetings-ui reads the shell's
  `PermissionsResult` (`apps: string[]`, `permissions: { resource, action }[]`) only to hide
  controls; the server enforces every action:
  - "New meeting", Templates, "Start meeting" and "Link an existing meeting" use
    `apps.includes('meetings')`;
  - the shared scope in the template form uses `{ resource: 'template', action: 'manage' }`;
  - the Erase tab uses `{ resource: 'meeting', action: 'erase' }`.

  The pairs are not app-qualified in that shape, so `template`/`meeting` would collide with a
  future catalog that declared the same resource key. auth gains a catalog test that fails
  when two catalogs declare the same resource key.

### Notifications (answers question 8, first half)

- In-app only (AC-12.4); the client never sets `email: true`, and meetings-api's service
  client holds `notifications.push` and `host-notices.send` only, never `emails.send`.
- **Recipients:**
  - an Operai participant added by someone else (AC-5.9/12.1);
  - the requester of a transcription, on finish or fail (AC-12.2);
  - the author of a summary, on finish or fail (AC-7.6).

  No one else, and never the actor.
- **Content:** the title and the outcome, plus a fixed sentence that the meeting was recorded
  or transcribed with AI. Never transcript, summary or answer text. Link
  `/my-meetings/m/<id>`.
- Best effort after commit (crm-api's `announce` pattern): nothing rolls back (AC-12.3).
- **Bilingual (AC-12.5)** needs a notify-api change. The suite has no per-user language on
  the server (the shell takes it from the browser), and every existing notification is
  English-only. So:
  - `POST /system/notifications` gains an optional `it: { title, body }`, stored as nullable
    `titleIt`/`bodyIt` and returned by the list and the SSE payload;
  - notify-ui and the shell's `ToastHost` pick the variant from `<html lang>`, falling back
    to `title`/`body`;
  - notify-api: `ORIGIN_APPS` + `meetings`, binding `system:meetings-api → ["meetings"]`.

  Rejected: English-only (fails AC-12.5); a per-user language stored in `auth` (a new profile
  attribute and a migration for every user, for one feature); message keys rendered by
  notify-ui (couples notify-ui to every tool's copy).

  Predicted ADR `docs/adr/0065-bilingual-system-notifications.md`.

### Rate limit (AC-13.4)

`ai_request(userId, kind, at)` is an append-only, content-free row per summary generation,
regeneration, retry, question and answer retry. Before inserting, a check counts the caller's
rows with `at > now() − 1 h` under a per-user `pg_advisory_xact_lock`. The 31st request gets
429 `ai_rate_limited` with `Retry-After` = seconds until the oldest of the 30 leaves the
window. The same transaction deletes that user's rows older than 1 h, so there is no sweep.
Deleting summaries or clearing a conversation does not refund requests.

### Other decisions (notes, not ADRs)

- **Concurrency:**
  - segment and summary edits use ADR-0038 `version` + `If-Match` (428/409);
  - meeting metadata has a single editor (the creator) and no precondition, crm-api's
    activity reasoning (D-7 of specs/017);
  - the summary count (≤ 20) and participants (≤ 30) are checked under a per-meeting
    advisory lock.
- **Audio playback** (AC-6.5) uses a 15-minute presigned GET (not ADR-0016's ~60 s) because
  `<audio>` makes range requests for the whole listening session; the client re-mints on a
  media `error`. The bucket is private, and the GET is minted only after the visibility check.
- **Transcript search** (AC-6.4) and **copy/download** (AC-6.6) are client-side over the
  loaded transcript (≈ 250 KB JSON for 3 h): `normalize('NFD')` minus combining marks, plus
  case folding. Nothing about the search text reaches a server or a log.
- **UI** per `operai-ui/docs/building-pages.md`:
  - `ToolLayout` "Meetings" with `TabNav` (Meetings · Templates · Erase, the last only for
    `meeting:erase`);
  - every page a `<section aria-labelledby>` with `PageHeader`, one state at a time;
  - lists through `DataTable` + filters `Card` + `Pagination`;
  - create through `FormDialog`, deletes through `ConfirmDialog tone="danger"` with
    `acknowledgeLabel`;
  - statuses through `StatusBadge` and one map in `lib/statusMeanings.ts`: draft→draft,
    recording→pending, interrupted→attention, processing→pending, ready→settled,
    failed→failed; summary generating→pending, ready→settled, failed→failed;
  - recording controls are `Button`s with an `aria-live="polite"` status line (AC-13.3), and
    the indicator is `Icon` + text + elapsed time (AC-2.2);
  - if `@operai/ui` has no progress bar at implementation time, a `ProgressBar` is added to
    the library with a story and a test (upload and save progress; refund and CRM uploads
    can reuse it).

### Changes to existing apps, infrastructure and rollout (answers question 8, second half)

- **shell:**
  - `meetings` remote in `vite.config.ts`, `runtimeRemotes.ts`, `remotes.d.ts` and the stubs;
  - routes `/meetings/$` (gated, `createToolAccessBeforeLoad('meetings')`) and
    `/my-meetings/$` (ungated child of `shellRoute`, absent from `TOOLS`);
  - a `TOOLS` entry `meetings` with its sidebar icon;
  - a UserMenu "My meetings" link;
  - `VITE_MEETINGS_API_URL` as a trusted origin plus `getMeetingsApiBaseUrl()`;
  - the new `./extensions` expose;
  - `registerNavigationBlocker` in `session.ts`;
  - About-modal source `meetings/version`;
  - `@source` for `meetings-ui/src`;
  - CSP and `Permissions-Policy` (§ Security);
  - strings in en/it.
- **crm-ui:**
  - DealDetailPage gains a "Meetings" section between Attachments and the timeline, as
    `<HostExtension name="meetings.hostMeetings" …>` with its own fallback `Banner` copy;
  - the timeline renders `activity.meeting` as an "Open meeting" link;
  - `CompanyDetailPage` stays unchanged (AC-11.7).
- **crm-api:** the two host endpoints, `systemAuth` (copied from notify-api), the migration,
  and the activity view field.
- **notify-api / notify-ui:** the `it` variant, the origin and its binding.
- **auth:** catalog, seeds, scope, client entry, directory gate.
- **Copied modules** in meetings-api: `serviceToken`, `s3Residency`, `jwt`/`authz`
  middleware, `problem`, `logger`. Add them to `scripts/check-shared-copies.ts`.
- **tools/env-doctor manifest:**
  - services `meetings-api` (railway, backend) and `meetings-ui` (vercel, frontend), with
    origins `https://meetings.operai.welld.io` and `http://localhost:5180`;
  - `meetings-api` added to the `AUTH_AUDIENCE`/`AUTH_JWKS_URL`/`AUTH_ISSUER`/`AUTH_BASE_URL`/
    `NOTIFY_INTERNAL_URL` service lists and to `resourceServers`;
  - a service-client link `meetings-api` with `requiredScopes: ["notifications.push",
    "host-notices.send"]`;
  - S3 prefix `MEETINGS_S3` (required);
  - `CRM_API_URL` targeting `crm-api`;
  - `SERVICE_AUDIENCE` added for `crm-api`;
  - `{ backend: "meetings-api", mustAllow: ["shell"] }`;
  - the provider variables as required production keys (values never printed).
- **Local:**
  - `compose.yaml`'s `minio-createbucket` creates `meetings` with
    `mc ilm rule add --expire-days 29` and versioning off;
  - `mise run dev` / `db:migrate` include meetings-api and meetings-ui;
  - a direnv file for meetings-api, like the other backends;
  - dev uses `MEETINGS_AI_PROVIDER=fake` until keys exist.
- **Rollout:** `provision-tool` for `meetings`:
  - Railway service `meetings-api` (EU West, DB `meetings`, Dockerfile with ffmpeg,
    `meetings-api.operai.welld.io`, `numReplicas: 1`);
  - Vercel project `meetings-ui` (`meetings.operai.welld.io`);
  - the shell env and `runtime-config.json` entry;
  - the EU bucket with its lifecycle rule, versioning off, and CORS (shell origin, `POST`
    and `GET`);
  - an Azure Speech resource in `westeurope`;
  - an AWS account/region with the Bedrock retention mode `none` and model access;
  - 1Password items;
  - the auth re-seed;
  - the `SERVICE_CLIENTS` entry.

  Order: auth (scope, client, catalog) → notify-api → crm-api → meetings-api → meetings-ui →
  shell. Each step degrades silently for the next. Changesets for every touched app.
- **Cost view (ops estimate, prices to confirm at provisioning).**
  - Per recorded hour: one fast-transcription hour.
  - Per summary: ≈ transcript tokens in (≤ ~50 k for 3 h) + ≤ ~3 k out.
  - Per question: transcript + up to 10 turns in, ≤ 1 k out.
  - The 30/h limit bounds the worst case per user at ≈ 30 × 60 k input tokens per hour.
  - The content-free `ai_request` rows and job durations give ops the volumes. A cost UI is
    a spec non-goal.

## Data model

### meetings-api (Prisma, DB `meetings`, one initial migration)

```prisma
enum MeetingFormat   { in_person online }
enum MeetingLanguage { en it }
enum MeetingSource   { recorded uploaded text }
enum MeetingStatus   { draft recording processing ready failed }   // `interrupted` is DERIVED, never stored
enum ProcessingStage { preparing transcribing }
enum SummaryStatus   { generating ready failed }
enum TurnStatus      { pending answered failed }
enum TemplateScope   { personal shared }
enum JobKind         { prepare_audio transcribe summarize deliver_host_notice }
enum JobState        { queued running done failed }
enum NoticeEvent     { linked changed unlinked deleted }
enum NoticePolicy    { manual until_delivered }
enum NoticeState     { pending delivered failed }

model Meeting {                                   // @@map("meeting")
  id                   String          @id @default(cuid())
  title                String          // 1..200
  format               MeetingFormat
  startsAt             DateTime        // the meeting date-time
  language             MeetingLanguage
  source               MeetingSource
  status               MeetingStatus   @default(draft)
  stage                ProcessingStage?
  failureCode          String?         // closed set in code: audio_unreadable | provider_unavailable | provider_rejected | too_long
                                       // on a draft: the last upload refusal, not a failure (Addendum 2026-11-05, AC-3.2)
  noSpeech             Boolean         @default(false)
  creatorUserId        String
  hostApp              String?         // hostApp/hostEntityType/hostEntityId: all or none (CHECK)
  hostEntityType       String?
  hostEntityId         String?
  hostVisible          Boolean         @default(false)    // CHECK (NOT hostVisible OR hostApp IS NOT NULL)
  hostNoticeSeq        Int             @default(0)
  consentUserId        String?         // consent*: all or none (CHECK); CHECK (source <> 'text' OR consentUserId IS NULL):
                                       // switching a draft to `text` clears the attestation; recorded ↔ uploaded keeps it (G1)
  consentAt            DateTime?
  consentNoticeVersion String?
  durationMs           Int?
  audioKey             String?         // meetings/<id>/audio.ogg
  audioBytes           Int?
  audioCreatedAt       DateTime?       // drives "kept until" = audioCreatedAt + 29 d (D-9)
  audioDeletedAt       DateTime?
  processingRequestedBy String?        // AC-12.2 recipient
  processingStartedAt  DateTime?       // non-null ⇒ language locked (AC-1.8)
  processedAt          DateTime?       // left `processing`
  transcriptVersion    Int             @default(0)
  createdAt            DateTime        @default(now())
  updatedAt            DateTime        @updatedAt
  @@index([creatorUserId, startsAt(sort: Desc)])
  @@index([hostApp, hostEntityType, hostEntityId])
}

model RecordingSession { id, meetingId → Meeting (Cascade), startedAt, lastChunkAt?, lastBeatAt,
  paused Boolean, capturedMs Int? /* G3: max reported by heartbeat/confirm */, endedAt?, endReason? }          // partial UNIQUE (meetingId) WHERE endedAt IS NULL (raw SQL)
model RecordingChunk   { meetingId → Meeting (Cascade), seq Int, sessionId, objectKey, sizeBytes Int,
  durationMs Int, storedAt DateTime?  @@id([meetingId, seq]) }
model MeetingUpload    { meetingId @id → Meeting (Cascade), objectKey, contentType, sizeBytes Int /* ≤ 500 MiB fits Int */, mintedAt }

model MeetingParticipant { id, meetingId → Meeting (Cascade), userId?, externalName? (1..100),
  externalOrganisation? (≤100), addedBy, createdAt
  // CHECK ((userId IS NULL) <> (externalName IS NULL)); CHECK (userId IS NULL OR externalOrganisation IS NULL)
  @@unique([meetingId, userId]) @@index([userId]) }

model TranscriptSegment { id, meetingId → Meeting (Cascade), ordinal Int, startMs Int?, endMs Int?,
  speakerKey String?, text String, edited Boolean @default(false), version Int @default(1)
  @@unique([meetingId, ordinal]) }               // text meetings: startMs/endMs/speakerKey NULL (passages)
model SpeakerLabel { meetingId → Meeting (Cascade), speakerKey, participantId? → MeetingParticipant (SetNull),
  customLabel? (1..100)  @@id([meetingId, speakerKey]) }

model Summary { id, meetingId → Meeting (Cascade), authorUserId, template Json /* snapshot: {source,
  templateId, name, sections[{heading,instruction}], generalInstructions,
  speakerNames: { [speakerKey]: string } } — speakerNames resolved at enqueue, see amendment 2026-11-05 */, language MeetingLanguage,
  status SummaryStatus, attemptId String, failureCode?, sections Json? /* [{heading, body, notDiscussed}] */,
  transcriptVersion Int, edited Boolean @default(false), version Int @default(1), createdAt, readyAt?
  @@index([meetingId, createdAt]) }

model SummaryTemplate { id, scope TemplateScope, ownerUserId? /* personal only, CHECK */, name (1..80),
  sections Json /* 1..15 × {heading 1..80, instruction ≤500} */, generalInstructions? (≤2000),
  createdBy, updatedBy, version Int /* If-Match on PATCH, G8 */, createdAt, updatedAt }
  // raw SQL: UNIQUE (ownerUserId, lower(name)) WHERE scope='personal'; UNIQUE (lower(name)) WHERE scope='shared'
  // built-in templates live in code (src/templates/builtin.ts, en + it), ids "builtin:minutes" |
  // "builtin:sales-discovery" | "builtin:one-on-one" | "builtin:action-items"

model ConversationTurn { id, meetingId → Meeting (Cascade), userId, question (1..1000), status TurnStatus,
  answer Json? /* {text, citations: segmentId[], notInMeeting} */, failureCode?, transcriptVersion Int,
  createdAt, answeredAt?  @@index([meetingId, userId, createdAt]) }

model AiRequest  { id, userId, kind String, at DateTime @default(now())  @@index([userId, at]) }   // content-free

model MeetingJob { id, kind JobKind, meetingId? → Meeting (Cascade), summaryId?, noticeId?, attemptId?,
  state JobState @default(queued), attempts Int @default(0), maxAttempts Int, runAfter DateTime @default(now()),
  leaseUntil DateTime?, lastErrorCode String?, createdAt, updatedAt  @@index([state, runAfter]) }

model HostNotice { id (uuid), hostApp, entityType, entityId, meetingId String /* NO FK: outlives deletion */,
  seq Int, event NoticeEvent, title String?, startsAt DateTime?, creatorUserId, policy NoticePolicy,
  state NoticeState, attempts Int, lastErrorCode?, createdAt, deliveredAt?  @@index([meetingId]) }

model MeetingDeletion { id, meetingId, deletedByUserId, via String /* creator | erase */, deletedAt }
  // content-free (no title, AC-4.6); Tier-1 append-only: BEFORE UPDATE/DELETE trigger (ADR-0018 mechanism);
  // tests reset it with TRUNCATE, which a row trigger does not block (cf. ADR-0033)
```

**Retention and deletion of bytes, without a cron — D-9.**
- **The bucket holds only audio** (chunks, uploaded originals, `audio.ogg`); transcripts and
  everything else live in Postgres.
- One **bucket-wide lifecycle rule**: expire current objects after **29 days**, and expire
  noncurrent versions too. S3 expiration rounds to the next midnight UTC, so an object is
  gone ≤ 30 days after its creation plus the provider's asynchronous removal lag.
- `audio.ogg` is created *during* processing, before the meeting leaves it, so deletion falls
  inside AC-4.4's "30 days (+ at most 24 h) after leaving `processing`".
- The rule also caps chunks of a never-processed `interrupted` meeting and orphaned
  presigned uploads at 29 days.
- **At startup** meetings-api reads `GetBucketLifecycleConfiguration` and
  `GetBucketVersioning` and refuses to start unless a rule with no prefix filter and
  `Days ≤ 29` exists and versioning is not `Enabled`. A versioned delete is not irrecoverable.
- **On read**: `audio` is
  - `{ state: "kept", until: audioCreatedAt + 29 d }`,
  - `{ state: "deleted" }` once `now ≥ until` or `audioDeletedAt` is set,
  - or `{ state: "none" }`.

  A read that observes expiry with `audioDeletedAt` null sets it and fires an idempotent
  `DeleteObject`: a lazy delete, ADR-0016 lineage. Playback and retry are then refused.
- **Explicit deletes** (AC-4.5 Delete recording; AC-4.6 delete meeting): list and delete the
  `meetings/<id>/` prefix **first**. If storage fails → 503 and nothing changes. Then delete
  the DB rows in one transaction: cascade + one `MeetingDeletion` row + one `deleted`
  `HostNotice` (no title) + removal of that meeting's other outbox rows.
- **Rejected:** a 30-day deletion cron (ADR-0013); delete-on-read only (an unread meeting
  would keep audio forever); per-object expiry tags (not portable across S3-compatible EU
  providers).

Predicted ADR `docs/adr/0063-audio-retention-bucket-lifecycle-verified-at-startup.md`.

- **Transcripts and summaries** live until the meeting is deleted (O2 working assumption).
  `MeetingDeletion` has no retention limit until O2 decides one. **Database backups** keep
  deleted content for the backup retention period: R7, for the data-protection lead.
- **Logging (AC-4.10):**
  - the request logger logs method, **path without query** (search terms are content),
    status and duration;
  - no bodies anywhere;
  - provider and S3 errors are logged as status + error code;
  - jobs log `kind`, ids, sizes and durations;
  - Prisma query logging is off and provider SDK debug logging is disabled;
  - titles are not logged either.

### crm-api (one migration)

```prisma
model Activity { …existing…
  meetingId String? @unique   // the meeting this activity mirrors (specs/021 US-14); CHECK (meetingId IS NULL OR type = 'meeting')
}
model MeetingHostState {      // content-free: ordering guard + tombstone per meeting
  meetingId String @id
  lastSeq   Int
  updatedAt DateTime @updatedAt
  @@map("meeting_host_state")
}
```

The reconciler runs in one transaction under `pg_advisory_xact_lock(hash(meetingId))`. A
notice with `seq ≤ lastSeq` is a no-op (`applied:false`). Otherwise:

| Event | Effect on the `meeting` activity |
|---|---|
| `linked` | The deal must exist (else 422 `entity_not_found`). Upsert by `meetingId`: `type=meeting`, `subject=title`, `occurredAt=startsAt`, `body=null`, `companyId=deal.companyId`, `dealId`, `authorUserId=creatorId`. An existing row is **moved** to the new deal and its company (relink, AC-14.7) |
| `changed` | Update `subject` and `occurredAt` if the row exists. Never recreates one the author deleted by hand |
| `unlinked` | Delete the row if it is on that deal |
| `deleted` | Delete the row wherever it is |

Every event then sets `lastSeq = seq`. The activity view gains `meeting: { id, href:
"/my-meetings/m/<id>" } | null`, and crm-ui's timeline renders an "Open meeting" link for it
(AC-14.2). The authorship rules of specs/017 AC-4.2 apply unchanged (AC-14.3). crm-api trusts
`system:meetings-api`'s `creatorId` because meetings-api resolved the entity *as that creator*
in the same request before emitting `linked`. That is also why AC-14.8's "creator lost
`crm:access`" surfaces as a refused link (AC-1.5) rather than a failed activity.

### Other services

- **auth:**
  - catalog `meetings` and its seeds (§ Authorization);
  - `KNOWN_SERVICE_SCOPES` + `host-notices.send`;
  - a `SERVICE_CLIENTS` entry `meetings-api` with scope `notifications.push host-notices.send`;
  - `DIRECTORY_GATE_PERMISSIONS` + `meetings:access`;
  - `meetings` in `ALL_APP_IDS`.
- **notify-api:**
  - `Notification.titleIt`/`bodyIt` (nullable, additive migration);
  - schema `it?`;
  - origin `meetings` and its binding.

## API contracts

### Conventions

- JSON bodies; RFC 7807 Problem JSON with a top-level `code` and extension members.
- Validation → 422 with `field` + `errors[]`, naming every invalid field (AC-1.3).
- Instants are ISO 8601; durations are integer ms.
- Every route: 401 without a valid token. Capability routes: 403 without the permission, 503
  when `auth` is unreachable.
- Title search (`q`) escapes `%`, `_` and `\` before `ILIKE` (`likeLiteral`; Prisma `contains`
  passes them through), so a search is always a literal substring.
- Record routes answer **404 `not_found`, byte-identical for "does not exist" and "not
  visible"** (AC-5.3).
- `ETag`/`If-Match` where noted: 428 `precondition_required`, 409 `version_conflict
  { currentVersion }`.
- Body limit 64 KiB, except `PUT /meetings/:id/text` (1 MiB).

```ts
type PersonRef = { id: string; name: string | null; status: 'active' | 'deleted' | 'unknown' }
type HostRef   = { app: string; entityType: string; entityId: string }
type HostView  = HostRef & { state: 'open' | 'closed' | 'missing' | 'unavailable'; title: string | null; href: string | null }
type Page<T>   = { items: T[]; total: number; page: number; pageSize: 25 }
type DerivedStatus = 'draft' | 'recording' | 'interrupted' | 'processing' | 'ready' | 'failed'
type PresignedPost = { url: string; fields: Record<string, string>; expiresAt: string }

type MeetingRow = { id; title; startsAt; format; status: DerivedStatus; host: HostView | null;
  role: 'creator' | 'participant' | 'host_reader'; summaryCount: number; creator: PersonRef }
// 'host_reader' appears only in a host's own list (GET /hosts/:app/:type/:id/meetings); My meetings
// rows are never 'host_reader' (amendment 2026-11-05 #1)
type Meeting = Omit<MeetingRow, 'role'> & {
  language: 'en' | 'it'; source: 'recorded' | 'uploaded' | 'text'; stage: 'preparing' | 'transcribing' | null;
  failure: { code: string } | null; noSpeech: boolean; durationMs: number | null;
  role: 'creator' | 'participant' | 'host_reader';
  frozen: boolean | null;                                        // null = creator identity unknown right now
  consent: { by: PersonRef; at: string; noticeVersion: string } | null;
  participants: ({ id; kind: 'operai'; person: PersonRef } | { id; kind: 'external'; name: string; organisation: string | null })[];
  hostVisible: boolean; hostVisibleOffered: boolean;
  audio: { state: 'kept'; until: string } | { state: 'deleted' } | { state: 'none' };
  recording: { live: boolean; durationMs: number; lostMs: number | null } | null;   // lostMs: creator only (G3)
  hostNotice: { state: 'failed'; event: 'linked' | 'changed' } | null;   // creator only
  transcriptVersion: number;
  capabilities: 'resolved' | 'unavailable';
  can: { edit; changeSource; changeLanguage; manageParticipants; link; setVisibility; capture;
         editTranscript; retryProcessing; deleteAudio; deleteMeeting; summarise; ask;
         retryHostNotice: boolean } }
// changeSource: creator control ∧ status draft ∧ no audio, chunk or text (G1).
// changeLanguage: creator control ∧ processingStartedAt null (AC-1.8).
```

### Hosts

| Route | Stack | Body / query | Answer |
|---|---|---|---|
| `GET /hosts` | selfScoped | | `{ items: [{ app, entityType, labels: { en, it: { app, entity, visibilityHint, noticeFailed } }, offersHostVisible, recommendedTemplates }] }` |
| `GET /hosts/:app/:type/:id` | capability(`meetings:access`) | | `{ host: HostView }`; 422 `host_not_registered`; 422 `host_entity_not_found` (missing **or** closed, identical, AC-1.5); 503 `host_unavailable` |
| `GET /hosts/:app/:type/:id/linkable-meetings` | capability(`meetings:access`) | `q?`, `page` | `Page<MeetingRow>` of the caller's own meetings as **creator**, not frozen, `host` ≠ this entity (standalone or linked elsewhere), `startsAt` desc (G2). 422 `host_not_registered`. Rows linked elsewhere get their host labels batch-resolved as the caller (≤ 25 ids per host, fail soft → `unavailable`, as in My meetings); the link itself (`PATCH host`) still resolves the target fail closed (amendment 2026-11-05 #3) |
| `GET /hosts/:app/:type/:id/meetings` | selfScoped (+ live checks for host readers) | `page` | `Page<MeetingRow>` of exactly what the caller may open (AC-11.2). No count of hidden rows. Host unreachable → only creator/participant rows plus `hostReadersUnavailable: true` |

### Meetings

| Route | Stack | Body | Answer |
|---|---|---|---|
| `GET /meetings` | selfScoped | `q?` (title, case-insensitive substring), `role?` (`creator`\|`participant`), `status?` (DerivedStatus), `hostApp?`, `page` | `Page<MeetingRow>`, creator or Operai participant only, `startsAt` desc (AC-10.1/10.2); host labels batch-resolved per page (≤ 25 ids per host, fail soft → `unavailable`) |
| `POST /meetings` | capability | `{ title, format, startsAt?, language, source, host?: HostRef }` (`startsAt` defaults to now, may be past) | 201 `Meeting`; 422 fields; 422 `host_not_registered`; 422 `host_entity_not_found`; 503 `host_unavailable` (AC-11.6) |
| `GET /meetings/:id` | selfScoped + visibility | | `Meeting` |
| `PATCH /meetings/:id` | capability + creator + not frozen | `{ title?, startsAt?, format?, language?, source?, host?: HostRef \| null, hostVisible? }` | `Meeting`; 409 `language_locked`; 409 `source_locked` (any audio, chunk or text exists; consent alone does not lock, so AC-2.3's fall-back to upload/paste works; G1, AC-3.5); 422 `host_visible_unavailable` (standalone, or host does not offer it); a host change re-resolves as the creator (AC-1.7) and emits notices |
| `DELETE /meetings/:id` | selfScoped + (creator ∧ ¬frozen) ∨ capability(`meeting:erase`) | | 204; 503 `storage_unavailable` (nothing deleted) |
| `PUT /meetings/:id/participants` | creator-control | `{ participants: ({ userId } \| { name, organisation? })[] ≤ 30 }` (full replace) | `Meeting`; 422 `participant_not_active` `{ index }`; 422 `too_many_participants`; 503 `identity_unavailable` |
| `POST /meetings/:id/consent` | creator-control | `{ noticeVersion }` | `Meeting`; 409 `notice_outdated`; 422 `consent_not_applicable` (`text`) |
| `POST /meetings/:id/host-notice/retry` | creator-control | | `Meeting` (`hostNotice` null on success) |

*creator-control* = capability(`meetings:access`) + creator + not frozen (403 `creator_only` /
`frozen` / `meetings_access_required`).

*creator-control (light)* = capability(`meetings:access`) + creator, **without** the live
frozen lookup. It is used only by the high-frequency recording routes: chunk confirm,
upload-url re-mint and heartbeat (amendment 2026-11-05 #2).

### Capture

| Route | Stack | Body | Answer |
|---|---|---|---|
| `POST /meetings/:id/recording/start` | creator-control | | 201 `{ sessionId, chunkSeconds: 10, maxChunkBytes: 8388608, next: PresignedPost /* seq 0 */ }`; 409 `consent_required` · `not_draft` · `recording_elsewhere` · `wrong_source` |
| `POST /meetings/:id/recording/chunks/:seq/confirm` (`seq` 0..19,999) | creator-control (light) | `{ sessionId, durationMs ≤ 15000, capturedMs? }` | `{ storedChunks: number, durationMs, next: PresignedPost }`; 409 `session_inactive` · `duration_limit`; 422 `chunk_missing` (HEAD 404) |
| `POST /meetings/:id/recording/chunks/:seq/upload-url` | creator-control (light) | `{ sessionId }` | `PresignedPost` (re-mint after expiry) |
| `POST /meetings/:id/recording/heartbeat` | creator-control (light) | `{ sessionId, paused: boolean, capturedMs: number ≤ 10 800 000 + 60 000 }` | 204 |
| `POST /meetings/:id/recording/stop` | creator-control | `{ sessionId, lastSeq }` | 202 `Meeting` (`processing`); 409 `chunks_missing { missing: number[] }` |
| `POST /meetings/:id/recording/process` | creator-control | | 202 `Meeting` (only from `interrupted`); 409 `audio_deleted` |
| `POST /meetings/:id/recording/discard` | creator-control | | `Meeting` (`draft`, chunks deleted) |
| `POST /meetings/:id/upload` | creator-control | `{ contentType, sizeBytes }` | `PresignedPost` (≤ 500 MiB, 30 min); 422 `unsupported_type` · `too_large`; 409 `consent_required` |
| `POST /meetings/:id/upload/confirm` | creator-control | | 202 `Meeting`; 409 `upload_incomplete`; 422 `upload_rejected { reason }` (meeting stays `draft`) |
| `PUT /meetings/:id/text` | creator-control | `{ text: 1..200000 }` | `Meeting` (`ready`) |
| `POST /meetings/:id/retry` | creator-control | | 202 `Meeting`; 409 `not_failed` · `audio_deleted` |
| `GET /meetings/:id/audio` | selfScoped + visibility | | `{ url, expiresAt }` (15 min); 409 `audio_unavailable` |
| `DELETE /meetings/:id/audio` | creator-control | | `Meeting`; 503 `storage_unavailable` |

### Transcript

| Route | Stack | Answer |
|---|---|---|
| `GET /meetings/:id/transcript` | selfScoped + visibility | `{ version, segments: [{ id, ordinal, startMs \| null, endMs \| null, speakerKey \| null, text, edited, version }], speakers: [{ key, label: { kind: 'default', index } \| { kind: 'participant', participantId } \| { kind: 'text', text } }] }` |
| `PATCH /meetings/:id/transcript/segments/:segmentId` | creator-control, If-Match | `{ text 1..10000 }` → segment; bumps `transcriptVersion` |
| `PUT /meetings/:id/transcript/speakers/:key` | creator-control | `{ participantId } \| { text: 1..100 } \| null` (null = back to "Speaker n"); 422 `participant_not_in_meeting` |

### Summaries

| Route | Stack | Answer |
|---|---|---|
| `GET /meetings/:id/summaries` | selfScoped + visibility | `{ items: [{ id, template: { name, source }, language, author: PersonRef, status, sections?, edited, stale, createdAt, version, can: { edit, delete, retry } }] }`. `can` is per item (G4): edit = (author ∨ creator) ∧ `meetings:access` ∧ `ready`; delete = author ∨ creator; retry = `failed` ∧ `meetings:access` (regenerate follows the meeting's `can.summarise`). `stale` = `transcriptVersion` behind the meeting's (AC-6.8). A `generating` older than 10 min reads `failed` |
| `POST /meetings/:id/summaries` | capability + visibility | `{ templateId, language }` → 202 summary; 409 `not_ready` · `no_speech` · `summary_limit`; 429 `ai_rate_limited`. At enqueue, with the caller's JWT, every speaker label mapped to an Operai participant is resolved through `/authz/users/identities` (fail **soft**: unknown, deleted or outage → "Speaker n") and stored as `template.speakerNames`; custom-text labels and external participants' names are copied as they are. The `summarize` job uses only that map and never calls `auth` |
| `POST /meetings/:id/summaries/:sid/regenerate` | same | 202 new summary: same template sections and language as the original (AC-7.4/7.5), **fresh** `speakerNames` resolved now |
| `POST /meetings/:id/summaries/:sid/retry` | same | 202 same row, new `attemptId`, same snapshot (`speakerNames` unchanged) |
| `PATCH /meetings/:id/summaries/:sid` | capability + visibility + (author ∨ creator), If-Match | `{ sections: [{ heading, body }] }` → summary, `edited: true` |
| `DELETE /meetings/:id/summaries/:sid` | selfScoped + visibility + (author ∨ creator) | 204 |

### Templates (capability `meetings:access`)

| Route | Answer |
|---|---|
| `GET /templates?meetingId=` | `{ items: [{ id, source: 'builtin' \| 'shared' \| 'personal', name, sections, generalInstructions, recommended, version }] }`: recommended for the meeting's host first, then personal, shared, built-in (AC-8.5); built-ins in the UI language (`Accept-Language`) |
| `POST /templates` | `{ scope, name, sections, generalInstructions? }`; `shared` needs `template:manage` (403); 409 `template_name_taken` |
| `PATCH /templates/:id` · `DELETE /templates/:id` | owner (personal) / `template:manage` (shared); built-in → 403 `builtin_readonly`. `PATCH` requires `If-Match: "<version>"` (ADR-0038): 428 / 409 `version_conflict` (G8); the precondition is the `version` carried by each `GET /templates` item |
| `POST /templates/:id/duplicate` | `{ language? }` → 201 personal copy (AC-8.4) |

### Conversation

| Route | Stack | Answer |
|---|---|---|
| `GET /meetings/:id/conversation` | selfScoped + visibility | `{ turns: [{ id, question, status, answer: { text, notInMeeting, citations: [{ segmentId, ordinal, startMs \| null, speaker: string \| null }] } \| null, createdAt }] }`, the caller's own only; `pending` older than 2 min reads `failed` |
| `POST /meetings/:id/conversation/questions` | capability + visibility | `{ question: 1..1000 }` → 201 turn (`answered` or `failed`, synchronous); 409 `no_speech` · `not_ready`; 429 `ai_rate_limited` |
| `POST /meetings/:id/conversation/questions/:tid/retry` | same | turn |
| `DELETE /meetings/:id/conversation` | selfScoped + visibility | 204 |

### Erase (capability `meeting:erase`)

`GET /erase/meetings?q&creatorId&from&to&page` returns `Page<{ id, title, startsAt, creator:
PersonRef }>`, nothing else (AC-4.7). Deletion uses `DELETE /meetings/:id`.

### crm-api additions

| Route | Auth | Contract |
|---|---|---|
| `POST /meeting-host/v1/resolve` | user JWT + live resolve (503 on outage) | § Host integration contract |
| `POST /system/meeting-host/v1/notices` | service JWT, scope `host-notices.send`, sub `system:meetings-api` | § Host integration contract; strict body |

### auth / notify-api additions

- auth: no new route. Catalog, seed, scope, client entry and directory gate as above.
- notify-api: `POST /system/notifications` accepts `it?: { title ≤ 200, body ≤ 2000 }`;
  `NotificationSchema` gains `it: { title, body } | null`.

### Environment (meetings-api)

> **Changed 2026-11-05.** The `AZURE_*`, `BEDROCK_*` and `MEETINGS_AWS_*` rows are replaced by the Google
> rows in § Amendment 2026-11-05 (provider change: Google Cloud) § G-7.

| Variable | Notes |
|---|---|
| `DATABASE_URL`, `ALLOWED_ORIGINS`, `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_BASE_URL`, `PORT` (8085), `NODE_ENV` | resource-server set |
| `MEETINGS_S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY`, `MEETINGS_S3_EU_ENDPOINT_HOSTS` | **required** (no "optional group": the tool is meaningless without audio storage); EU-validated; lifecycle and versioning checked at start |
| `NOTIFY_INTERNAL_URL`, `SERVICE_CLIENT_ID`, `SERVICE_CLIENT_SECRET` | all or none; required in production |
| `CRM_API_URL` | internal; the CRM host's base URL |
| `AZURE_SPEECH_REGION`, `AZURE_SPEECH_KEY` | transcription |
| `BEDROCK_REGION`, `BEDROCK_MODEL_ID`, `MEETINGS_AWS_ACCESS_KEY_ID`, `MEETINGS_AWS_SECRET_ACCESS_KEY` | LLM. Least-privilege IAM: `bedrock:InvokeModel` on the pinned model/profile, `bedrock:GetInferenceProfile`, `bedrock:GetAccountDataRetention` in the home Region and in every destination Region of the profile |
| `MEETINGS_AI_PROVIDER` | `real` (default, required in production) \| `fake` (dev/test/e2e only) |
| `MEETINGS_WORKER` | `on` (default) \| `off` \| `only` |
| `MEETINGS_TEST_HOSTS` | test only; refused in production |

New elsewhere:
- crm-api: `SERVICE_AUDIENCE`, plus `AUTH_JWKS_URL` (already set) for service tokens.
- shell: `VITE_MEETINGS_API_URL`, `MEETINGS_REMOTE_URL`, runtime-config `meetings`.
- auth: `SERVICE_CLIENTS` gains `meetings-api`.

## Test strategy

Levels:
- **unit**: pure modules, `bun test` in meetings-api / vitest in the UIs.
- **component**: vitest + Testing Library with stubbed `shell/session` / `shell/extensions`.
- **integration**: meetings-api route tests against Postgres. They use:
  - the `test-support/testAuth.ts` pattern (stubbed `/authz/resolve` and `/authz/users/identities`);
  - a fake storage that records keys and deletes, with real MinIO for the lifecycle/versioning startup check;
  - fake `Transcriber`/`LanguageModel`;
  - the fake host server(s);
  - a recording notifier;
  - an injectable clock.
- **contract**: crm-api route tests for the two host endpoints, and auth/notify-api tests for
  their changes.
- **e2e**: Playwright in `shell/e2e/meetings-*.spec.ts`, Chromium with
  `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`, the stack with
  `MEETINGS_AI_PROVIDER=fake` and the fake hosts.
- **eval**: `meetings-api/evals` against the real EU provider (release and model-change gate).

| AC | Level | What proves it |
|---|---|---|
| AC-1.1 | e2e + integration | deal page → Start meeting → form shows title = deal title and "Deal · <title>"; `GET /hosts/crm/deal/:id` returns the crm-api title |
| AC-1.2 | integration | `POST /meetings` without `host` → host null, `GET` shows standalone |
| AC-1.3 | integration + unit | each missing/invalid field (title 0/201 chars, format, language, source, bad date) → 422 naming the field, row count unchanged; omitted `startsAt` = now; past accepted; form unit test names fields |
| AC-1.4 | integration + e2e + component | no `meetings:access` → `POST /meetings` 403; e2e: no sidebar entry, deal panel without Start meeting; `HostMeetings` hides the button |
| AC-1.5 | integration | fake host `missing` vs `closed` → identical status and body (byte compare), no row |
| AC-1.6 | integration | unknown app and unknown entity type → 422 `host_not_registered`, no row |
| AC-1.7 | integration + component | linkable list = caller's own creator meetings only (a participant's or a frozen one is absent, this entity's excluded); "Link an existing meeting" → `PATCH host` (G2); PATCH host to a `closed` entity → refused; to an `open` one → old entity's host reader 404 / new one 200 on the next request; fake host records `unlinked`(old) + `linked`(new) |
| AC-1.8 | integration | participant PATCH → 403 `creator_only`; language PATCH after `processingStartedAt` → 409 `language_locked` |
| AC-2.1 | unit + integration | controller never calls `getUserMedia` before consent; `recording/start` without consent → 409 `consent_required` |
| AC-2.2 | component + e2e | indicator shows icon + "Recording" + elapsed; e2e fake device → meeting `recording` |
| AC-2.3 | component + integration | `getUserMedia` rejects `NotAllowedError` / `NotFoundError` → message, upload/text offered, no `recording/start` call (meeting stays `draft`); after consent, `PATCH source` to `uploaded` keeps the attestation and to `text` clears it; `can.changeSource` true (G1) |
| AC-2.4 | unit + component | capability matrix (Chromium/Edge → mic + tab; Firefox/Safari → mic only + warning + upload recommendation) |
| AC-2.5 | unit | display stream with no audio track, and the track `ended` event → message; mixer keeps the mic node and chunks keep coming |
| AC-2.6 | unit + integration | pause → `recorder.pause`, no chunks, elapsed and `durationMs` exclude the paused span; heartbeat keeps the session live; "Paused" indicator |
| AC-2.7 | component + integration | Stop shows "Saving n of m" until every confirm; `stop` with a gap → 409 `chunks_missing`; complete → `processing` |
| AC-2.8 | integration + e2e | clock + 2 min with no chunk/heartbeat → reads `interrupted`, `durationMs` kept, process/discard work; static test: no code path writes status from a time comparison; e2e: close the page mid-recording, reopen → `interrupted`, stored duration ≥ recorded − 20 s |
| AC-2.9 | unit + integration + e2e | `lostMs` = last `capturedMs` − stored durations (vectors incl. null when never reported, floor 0), creator-only; UI "at least …" vs fallback sentence; uploader backs off and requeues while offline, indicator "Audio not yet saved" (and survives only while this tab is open); e2e `context.setOffline(true)` 40 s → back online → every seq stored, one session |
| AC-2.10 | unit + e2e | `beforeunload` registered while recording/unsaved; shell `registerNavigationBlocker` honoured by `useBlocker` (shell unit); e2e sidebar click during recording → confirmation |
| AC-2.11 | unit + integration | fake timers: warning at 2 h 50, auto-stop + save + `processing` at 3 h; chunk past 3 h + 60 s → 409 `duration_limit`; `seq` 20,000 → 422; second `start` while live → 409 `recording_elsewhere`; the light routes make no identities call (stub counts zero) while start/stop make one |
| AC-3.1 | integration | upload → confirm → `processing`; `prepare_audio` on an mp4 video fixture → only `audio.ogg` stored, original deleted; ffmpeg args include `-vn -sn -dn` |
| AC-3.2 | integration | mint: unsupported type / > 500 MiB → 422; confirm with fixtures (no audio track, metadata duration > 3 h, HLS playlist / unknown demuxer) → 422 `upload_rejected` with reason, object deleted, status `draft` |
| AC-3.3 | component + integration | XHR error → failure shown + Retry; confirm without an object → 409 `upload_incomplete`, status stays `draft` |
| AC-3.4 | integration | `PUT text` with 200,000 chars → `ready`, passages without times; 200,001 → 422; no consent asked; summary and question succeed on it |
| AC-3.5 | integration | after audio, a chunk or text exists, `PATCH source` → 409 `source_locked` and `can.changeSource=false` (consent alone does not lock, G1); `recording/start` on a `ready` meeting → 409 |
| AC-4.1 | component + unit | Proceed disabled until ticked; en/it notice strings contain the five required statements (string test); integration: `start` needs nothing but consent (no other gate exists) |
| AC-4.2 | component | Copy announcement writes the localised text to the clipboard |
| AC-4.3 | integration | consent stores user/at/version; participant and host reader see it in `GET` |
| AC-4.4 | integration + unit | `audio.until` = `audioCreatedAt` + 29 d; clock past it → `deleted`, audio URL 409, lazy `DeleteObject` once; same for a frozen meeting; startup check refuses: no rule, `Days > 29`, prefix-filtered rule, versioning enabled |
| AC-4.5 | integration | `DELETE audio` → prefix deleted, `audio.state=deleted`, audio URL and retry → 409; storage failure → 503, nothing changed |
| AC-4.6 | integration + e2e | delete by creator and by erase holder → zero rows for the id in every table, prefix deleted, one `MeetingDeletion` whose columns hold no title, `deleted` notice with null title, then `GET` 404 and absent from every list; e2e dialog states it cannot be undone |
| AC-4.7 | integration + component | Erase tab shown only with the `meeting:erase` hint (G5); erase list keys are exactly `{id, title, startsAt, creator}`; the erase holder gets 404 on `GET /meetings/:id`, transcript, summaries, conversation |
| AC-4.8 | integration | admin holding every permission, not a participant → 404 on every content route |
| AC-4.9 | unit | env tests: non-EU S3, non-EU/CH Azure region, endpoint/region mismatch, Bedrock region `eu-west-2`/`us-east-1`, profile with a non-allowlisted destination (stubbed `GetInferenceProfile`), retention ≠ `none` or unreadable in the home Region **or in any one destination Region**, `fake` provider in production → exit 1 |
| AC-4.10 | integration | log-privacy test: canary strings in title, transcript, summary, question and answer, run through every route and job, captured console contains none |
| AC-4.11 | unit + e2e | static scan: capture/upload modules reference no `indexedDB`/`caches`/`localStorage`/`sessionStorage`; e2e after Stop and after Discard: `indexedDB.databases()` empty, no storage keys, CacheStorage empty |
| AC-5.1 | integration + component | 30 ok, 31 → 422; inactive id → 422 `participant_not_active`; external name 1..100, organisation ≤ 100; externals never notified; picker calls the directory with no `appId` parameter (G9, asserted on the request) |
| AC-5.2 | integration | visibility matrix: creator, participant, host reader (with/without `meetings:access`, with/without host `hostVisible`), outsider → only the AC's set opens |
| AC-5.3 | integration | not-visible vs nonexistent id → identical status and body on every record route |
| AC-5.4 | integration | added participant opens at once, existing summaries included; removed → next request 404 |
| AC-5.5 | integration + component | checkbox hint renders the host's `visibilityHint` (G6); toggle on → host reader 200; off → next request 404; standalone and `quiethost`-style non-offering host → 422 `host_visible_unavailable` |
| AC-5.6 | contract + integration + e2e | crm-api resolve: `hostVisible` = `deal:financials`; meetings-api: `hostVisible:false` → not in the deal list and 404; e2e `crm-technical` + meetings user cannot see a host-visible deal meeting |
| AC-5.7 | integration | fake host flips the caller to `closed` → next request 404; the same caller as participant keeps access |
| AC-5.8 | integration | role × action matrix over the assembled route table (crm-api `matrix.test.ts` pattern): expected 2xx or 403 code per cell |
| AC-5.9 | integration | `PUT participants` → notifier got one push per newly added Operai user, not the actor, not externals, not existing ones |
| AC-5.10 | integration + component | identities `deleted` → `PersonRef{status:"deleted", name:null}`; rendered "Deleted user" |
| AC-5.11 | integration + component | creator identity `deleted` → `frozen:true`; every creator control → 403 `frozen` for every caller; participant with access can summarise/ask; author edits/deletes own summary; banner "Frozen: …"; identity lookup down → creator control 503 |
| AC-5.12 | integration | erase holder deletes a frozen meeting; frozen audio expiry identical; no notice emitted while frozen |
| AC-5.13 | integration | identities back to `active` → creator control 2xx on the next request |
| AC-6.1 | integration + component | segments ordered by `startMs`; text meeting renders without times |
| AC-6.2 | unit + integration | provider phrases → segments, labels by first appearance, single voice → one label; rename → all segments show the new label; text label 101 chars → 422; a participant of another meeting → 422 `participant_not_in_meeting` |
| AC-6.3 | integration | segment edit without If-Match → 428, stale → 409, success → `edited:true`, version + 1, `transcriptVersion` + 1 |
| AC-6.4 | unit + component | `fold()` vectors (case, accents: "perché" ~ "PERCHE"); highlight count matches |
| AC-6.5 | integration + component | audio URL only while kept; control absent once `deleted` |
| AC-6.6 | unit + component | text export: `[hh:mm:ss] Name: text` lines; copy and download buttons |
| AC-6.7 | integration + component | provider returns no phrases → `ready`, `noSpeech`; summary/question → 409 `no_speech`; controls disabled with the message |
| AC-6.8 | integration | edit after a summary → `stale:true`; no job enqueued by the edit |
| AC-6.9 | integration + component | provider permanent error → `failed` + code, no segments; retry while kept → `processing`; after expiry → 409 `audio_deleted`, `can.retryProcessing=false` |
| AC-6.10 | component | stage labels (Saving, Uploading, Preparing, Transcribing) from state; polling with backoff, sidebar navigation stays live |
| AC-7.1 | integration + unit | `POST summaries` → 202 `generating` → job → `ready` (fake LLM); default output language = UI language (unit); the snapshot carries `speakerNames` for participant-mapped labels, an identities outage at enqueue still gives 202 with "Speaker n", and the job's prompt uses the stored names with no call to `auth` (stub asserts zero calls) |
| AC-7.2 | unit + component | renderer: template order, server headings, `notDiscussed` → localised "Not discussed"; "AI-generated" label with template, language, author, time |
| AC-7.3 | integration | 20 created (several from one template), the 21st → 409 `summary_limit`, concurrent pair under the lock |
| AC-7.4 | integration | regenerate → new row, same template sections and language, `speakerNames` re-resolved (a participant renamed in between shows the new name in the new row only), old row unchanged; retry keeps the row's `speakerNames` |
| AC-7.5 | integration | edit and delete the template after generating → summary snapshot byte-identical |
| AC-7.6 | integration + component | job done/failed → notifier to the author with title and outcome only; page shows the current state on return |
| AC-7.7 | integration | per-item `can.edit` matches the route outcome for author/creator/other/no-access (G4); author and creator edit with If-Match (428/409), others 403 `author_only`; `edited:true`; regenerate leaves it untouched |
| AC-7.8 | integration | author and creator delete; others 403; per-item `can.delete` matches (G4) |
| AC-7.9 | integration | fake LLM timeout/5xx/invalid output → `failed` + retry, never partial `ready`; `generating` > 10 min reads `failed`; other routes unaffected |
| AC-7.10 | unit | request snapshot contains only system prompt + template + transcript; tool list = the output schema; summarizer module imports no host or summary client (static) |
| AC-7.11 | integration + component | every visibility class reads summaries; copy-as-text button |
| AC-7.12 | unit + eval | hostile fake outputs neutralised (headings, order, count from the template); eval injection fixtures (it/en) pass |
| AC-8.1 | unit + integration | four built-ins with en+it name/sections/instructions; PATCH/DELETE → 403 `builtin_readonly`; recommended = Sales discovery call for `crm/deal` |
| AC-8.2 | integration | personal CRUD; limits (80/15/80/500/2000); unique among own, case-insensitive; invisible to others |
| AC-8.3 | integration + unit | shared without `template:manage` → 403; `PATCH` without If-Match → 428, stale → 409 (G8); template-form shared option hidden without the hint pair (G5); unique across shared, case-insensitive; usable by any `meetings:access` holder |
| AC-8.4 | integration | duplicate built-in (in a chosen language) and shared → personal, editable |
| AC-8.5 | integration | `GET /templates?meetingId` order and `source`/`recommended` flags |
| AC-8.6 | unit | built-in snapshot in the output language; personal headings verbatim; LLM instructed to write in the chosen language |
| AC-8.7 | integration | same test as AC-7.5 run with template edit and delete |
| AC-9.1 | integration + component | question 1..1000 (0 and 1001 → 422) → answered; "AI-generated" label; prompt instructs the question's language |
| AC-9.2 | unit | prompt built from current segments only (no summaries, no other meeting, no host data) |
| AC-9.3 | integration + component | unknown citation ids dropped; uncited → `notInMeeting`, no passages; click scrolls to and highlights the segment / passage |
| AC-9.4 | unit | prompt contains the previous 10 turns, not the 11th |
| AC-9.5 | integration | another user (the creator included) gets only their own turns; clear deletes only the caller's |
| AC-9.6 | integration | LLM timeout → turn `failed` with retry, no answer text; `pending` > 2 min reads `failed` |
| AC-9.7 | unit + eval | answer schema enforced under hostile fake output; eval: off-scope injection → `notInMeeting` |
| AC-9.8 | integration + component | 31st AI request → 429 `ai_rate_limited` + `Retry-After`; message names when to retry |
| AC-10.1 | e2e + integration | zero-grant user opens My meetings from the user menu, sees only their own; admin sees only their own |
| AC-10.2 | integration | row fields, `startsAt` desc, 25 per page, `q` substring case-insensitive, with `%` and `_` matched literally; role/status (incl. derived `interrupted`)/host filters |
| AC-10.3 | integration + component | fake host `open` → "Deal · title" link, `closed`/`unavailable` → "CRM · deal", `missing` → "No longer available" |
| AC-10.4 | integration + e2e | participant without `meetings:access` reads transcript and summaries; every mutation → 403 `meetings_access_required`; no controls; no sidebar entry |
| AC-10.5 | e2e | holder sees Meetings in the sidebar with New meeting and Templates |
| AC-10.6 | integration + component | resolve stub 503 → list, open, transcript, summaries 200 for creator/participant; capability routes 503; banner shown, controls hidden |
| AC-10.7 | component | empty state with and without New meeting |
| AC-10.8 | contract (auth) | seed: `employee` holds `meetings:access`; `template:manage`/`meeting:erase` only on `admin`; no other rule mentions them |
| AC-11.1 | unit | production registry is exactly `crm/deal` with requirement and notices flags; `MEETINGS_TEST_HOSTS` with `NODE_ENV=production` → exit 1 |
| AC-11.2 | integration + e2e | deal list = exactly what the viewer may open, newest first, title/date/status/summaryCount/creator, `role: "host_reader"` on host-visible rows; response has no hidden counts; empty state + Start meeting for holders |
| AC-11.3 | e2e | meeting started from a deal appears in the deal's section and in My meetings |
| AC-11.4 | integration + component | `testhost/widget` runs create/list/open/visibility/summaries/questions through the same suite as CRM; `quiethost/gadget` receives no notice; meeting screens render a testhost meeting from `/hosts` labels |
| AC-11.5 | integration | fake host `missing` → "No longer available", host readers 404, creator/participant still open |
| AC-11.6 | unit (shell) + component (crm-ui) + integration + e2e | `HostExtension`: reject, 5 s timeout, missing export, render throw → fallback; crm-ui fallback when `shell/extensions` is absent; host resolve 503 → create-with-host 503 `host_unavailable`, standalone 201; e2e meetings-api stopped → deal page loads with the unavailable notice |
| AC-11.7 | component | company page renders no meetings extension |
| AC-11.8 | integration | fake host records exactly one notice per event (link at create, later link, title change, date change, relink → unlinked + linked, unlink, delete); payload keys = allowlist; `title` null on unlinked/deleted |
| AC-11.9 | integration + component | fake host 500 → action 2xx, `hostNotice.state=failed`; retry route delivers; non-blocking banner with Try again |
| AC-11.10 | integration | fake host saw only `resolve` and `notices` paths; the host client module exports only those two calls (static) |
| AC-12.1 | integration | participant push carries the link and the AI sentence, en + it |
| AC-12.2 | integration | transcription done/failed → requester; summary done/failed → author; payload strings built from catalog + title only (no segment/summary/answer text) |
| AC-12.3 | integration | notifier throws / notify 500 → action 2xx, no rollback |
| AC-12.4 | integration + contract (auth) | no push with `email:true`; no push to other participants on summary create; `meetings-api` client scopes lack `emails.send` |
| AC-12.5 | unit + contract (notify-api) + component (notify-ui, shell) | meetings notification catalog en/it parity; notify-api stores/returns `it`; list item and toast pick the `it` variant under `<html lang="it">` |
| AC-13.1 | unit | meetings-ui `catalogGaps` parity + hard-coded-copy scan; crm-ui and shell new strings parity |
| AC-13.2 | integration | language `de` → 422; transcriber called with the meeting's locale only; no translation step |
| AC-13.3 | component + e2e | start/pause/resume/stop by keyboard; `aria-live` announces each change; axe pass on the capture page |
| AC-13.4 | integration | summaries + questions + retries share one 30/h window; `Retry-After` value correct with a fixed clock |
| AC-14.1 | contract (crm-api) + e2e | `linked` → one `meeting` activity on the deal's company with `dealId`, in both timelines; e2e from deal to timeline, and e2e "Link an existing meeting" on a deal → activity appears (G2) |
| AC-14.2 | contract (crm-api) | subject = title, occurredAt = startsAt, `body` null + `meeting.href`; a notice with any extra key → 422 |
| AC-14.3 | contract (crm-api) | `authorUserId` = creator; another user's PATCH/DELETE → 403 `author_only`; author shown by live name |
| AC-14.4 | e2e | CRM reader without meeting access follows the link → not found; the activity still shows title and date |
| AC-14.5 | integration + contract | title/date change → one `changed` notice; crm-api updates subject/occurredAt |
| AC-14.6 | integration + contract | delete with the fake host failing 3× → delivered by retry jobs, the deletion itself 204 at once; crm-api `deleted` removes the activity |
| AC-14.7 | contract (crm-api) + integration | relink through the linkable list from deal B emits unlinked(A) + linked(B) (G2); `unlinked` removes; relink → activity moved to the new deal's company; out-of-order seq ignored |
| AC-14.8 | integration + component | crm-api down at creation → meeting 201, `hostNotice` failed, banner text = the host's `noticeFailed` in the UI language (G7), no retry job for `linked`, manual retry delivers |
| AC-14.9 | contract (crm-api) | same notice twice, and retries → one activity (`meetingId` unique + seq guard) |
| AC-14.10 | integration | frozen meeting: `can.retryHostNotice=false`, retry route 403 `frozen`, no notices |
| AC-14.11 | integration | standalone and `testhost` meetings → fake crm records no call |

**Mapping result: 123 of 123 ACs mapped, no AC unmapped.** Two mappings depend on proposed
amendments: AC-2.8 (A1 heartbeat liveness, A2 offline survival) and AC-11.8 (A3 null title).
The eval suite and the week-1 spike (R2) sit outside the AC mapping as release gates.

## Risks

| # | Risk | Mitigation / early check |
|---|---|---|
| R1 | A provider changes residency or retention terms, or the pinned model starts requiring retention (Bedrock already does for Claude Fable 5) | Startup checks refuse to run; the model id is pinned; any change needs a green eval; fallbacks behind the same interfaces; O3 review of the DPAs before go-live |
| R2 | Fast transcription on a 3 h file is slower than the target or times out on a single request | **Week-1 spike**: transcribe 1 h and 3 h synthetic Italian files from Railway Amsterdam and record latency. Fallback: Azure batch transcription in the same region (async, polled from the job, audio passed through a 60 s presigned GET) |
| R3 | Diarization quality on mixed mic + tab audio (echo, cross-talk) | Best effort per AC-6.2; echo cancellation on the mic; UI recommends headphones; speaker rename |
| R4 | Browser variance: tab audio only in Chromium; Safari fMP4 chunks; MediaRecorder pause timestamps | Capability matrix shown before recording (AC-2.4); normalisation fixtures from Chrome, Firefox and Safari chunk streams in the test suite |
| R5 | Audio captured while offline is lost if the tab then dies (memory-only buffer, required by AC-4.11) | Amendment A2; indicator "Audio not yet saved"; `beforeunload` |
| R6 | In-process worker: deploys interrupt long jobs; re-runs cost a second transcription | Lease re-claim; SIGTERM drain; split into its own service on the stated trigger |
| R7 | Postgres backups keep deleted transcripts beyond deletion; "irrecoverable" depends on backup retention | Data-protection lead (O2): document Railway backup retention or encrypt meeting content with a per-meeting key destroyed at deletion (crypto-shredding) as a follow-up |
| R8 | Cost: a heavy user × 30 AI requests/h × ~50 k tokens of context | Rate limit; worker concurrency cap; prompt caching if compatible with `none`; content-free `ai_request` + job durations give ops the volumes (AI cost reporting is a spec non-goal) |
| R9 | Host resolve fan-out makes lists slow | One batched call per host per page (≤ 25 ids), 2 s timeout, fail soft for labels |
| R10 | The chosen EU S3 provider does not support lifecycle rules or reading them | Startup check refuses; verify during provisioning (MinIO, AWS, Scaleway and Hetzner support expiration rules) |
| R11 | A broken meetings-ui deploy affects the deal page | Error boundary + timeout + host fallback; e2e on the deal page; meetings-ui versioned in the About modal |
| R12 | Directory visible to every employee | ADR-0066 decision; data-protection lead sign-off; rate limit unchanged |
| R13 | The Bedrock EU profile routes outside the EU/CH allowlist | `GetInferenceProfile` destination check at startup; prefer in-region `eu-central-2` |
| R14 | Residual prompt injection, e.g. a misleading summary paragraph | Structural defences; plain-text rendering; "AI-generated" label; evals; the transcript stays one click away |
| R15 | ffmpeg/ffprobe parsing hostile media (CVE class), SSRF via playlist demuxers | Demuxer allowlist, protocol whitelist, non-root, timeouts, per-job temp dir, image patch cadence; security review item |
| R16 | Spec amendments A1–A4 not accepted | The plan isolates each: A1 is a one-line liveness rule; A2 would need an IndexedDB outbox that conflicts with AC-4.11; A3 would keep a title in the outbox until delivery; A4 changes one matrix row |

## Security

**Security-sensitive: YES.** The feature records people's voices and conversations
(personal data, potentially biometric-adjacent; clients in energy, finance and healthcare),
sends them to third-party AI processors, accepts large file uploads parsed by ffmpeg, adds a
service-to-service trust (`host-notices.send`) and a cross-service authorization decision
(host resolve), widens the user directory to every employee, and is the suite's first
LLM-facing surface (prompt injection). Schedule the `owasp-reviewer` in parallel with QE and
**escalate to the frontier tier** (regulated data, voice recordings).

Surfaces to review:
- **meetings-api:**
  - every record route: IDOR, the 404 taxonomy, the matrix of AC-5.8;
  - the `selfScoped` vs capability split (it must not become fail-open);
  - presigned POST policies (chunk ≤ 8 MiB, upload ≤ 500 MiB, fixed keys, content-type
    allowlist, expiry);
  - the 15-minute audio GET;
  - ffprobe/ffmpeg invocation;
  - prompt construction and escaping, output validation, plain-text rendering;
  - the rate limiter;
  - startup residency, lifecycle and versioning checks;
  - log privacy (AC-4.10);
  - `MEETINGS_TEST_HOSTS` and the `fake` provider refused in production;
  - deletion completeness (DB cascade, bucket prefix, outbox).
- **crm-api:**
  - `POST /meeting-host/v1/resolve`, an existence oracle for deal ids toward non-CRM users
    (accepted: ids are unguessable cuids, no title leaks);
  - `POST /system/meeting-host/v1/notices`: service JWT audience/scope/sub binding, strict
    body, seq/idempotency, activity authorship trust.
- **auth:**
  - the `host-notices.send` scope and the `meetings-api` client entry;
  - `DIRECTORY_GATE_PERMISSIONS` + `meetings:access`;
  - the first default `employee` grant.
- **notify-api:** origin binding `system:meetings-api → meetings`; the `it` variant fields
  (same length limits, no HTML).
- **shell:**
  - CSP `connect-src` (meetings-api, meetings bucket) and `media-src` (bucket);
  - `Permissions-Policy: microphone=(self), display-capture=(self), camera=()`;
  - the `./extensions` seam;
  - the navigation-blocker seam.
- **Processors:** Azure Speech (`westeurope`), Bedrock EU with `data_retention_mode: none`.
  DPA/O3 sign-off before production data.

## ADR candidates

Each one is a decision with a rejected alternative; paths are predicted.

1. **0058 — Meetings tool shape and visibility by participation**
   (`docs/adr/0058-meetings-tool-shape-visibility-by-participation.md`). meetings-api +
   meetings-ui with a gated `./App`, an ungated `./MyMeetings` at `/my-meetings`, and a
   `./HostMeetings` panel. Self-scoped reads that survive an `auth` outage; no role reads
   content. *Rejected:* meetings inside crm-api; one ungated entry with in-remote gating; a
   shell-native screen.
2. **0059 — Meeting host contract: resolve with the caller's JWT, content-free notices with
   seq** (`docs/adr/0059-meeting-host-contract-resolve-and-notices.md`). Host registry as data,
   `open|closed|missing` answers, fail closed for grants, outbox with manual vs
   until-delivered policies, new scope `host-notices.send`. *Rejected:* meetings-api reading
   host data; a shared-secret webhook; event-without-seq delivery (reordering breaks
   relink); a host-side service credential for resolve (the host must apply the *caller's*
   permissions).
3. **0060 — Host extension: a federated panel loaded through `shell/extensions`**
   (`docs/adr/0060-host-extension-federated-panel-through-the-shell.md`). Distinguishes the
   case from ADR-0050 option D. *Rejected:* host-owned UI calling meetings-api; navigation
   only; host-declared MF remotes; an iframe.
4. **0061 — AI processing: Azure Speech fast transcription (EU) + Claude on Bedrock EU with
   zero retention, enforced at startup** (`docs/adr/0061-meetings-ai-providers-eu-zero-retention.md`).
   *Rejected:* Anthropic first-party API (no EU geo); Azure OpenAI without modified abuse
   monitoring; Mistral as primary; AWS Transcribe; self-hosted Whisper.
5. **0062 — Durable job runner: work is queued, state stays derived**
   (`docs/adr/0062-durable-job-runner-work-queued-state-derived.md`). Postgres job table,
   SKIP LOCKED, lease, in-process worker, and an explicit boundary with ADR-0013.
   *Rejected:* synchronous processing; fire-and-forget; Redis/SQS; Railway cron; lazy kick on
   read.
6. **0063 — Audio retention by a bucket-wide 29-day lifecycle rule verified at startup**
   (`docs/adr/0063-audio-retention-bucket-lifecycle-verified-at-startup.md`), plus lazy
   delete on read and versioning forbidden. *Rejected:* deletion cron; delete-on-read only;
   per-object tags.
7. **0064 — meetings-api reads audio bytes (third reader, ADR-0057's trigger)**
   (`docs/adr/0064-meetings-api-reads-audio-bytes-third-reader.md`). Bounded to disk,
   ffmpeg hardening. *Rejected:* client-side ffmpeg.wasm; a third-party media service;
   sending raw uploads to the transcriber.
8. **0065 — System notifications carry an optional Italian variant**
   (`docs/adr/0065-bilingual-system-notifications.md`). *Rejected:* English-only; a per-user
   language stored in `auth`; message keys rendered by notify-ui.
9. **0066 — User directory gate widened to `meetings:access` (every employee)**
   (`docs/adr/0066-user-directory-gate-meetings-access.md`), ADR-0047's trigger, third
   consumer. *Rejected:* a name-only typeahead endpoint (a new fact endpoint with search,
   which ADR-0047 rejected); emailing participants by address.
10. **0067 — AI output is structured, validated and rendered as plain text; whole record in
    context, no embeddings store** (`docs/adr/0067-ai-output-structured-validated-plain-text.md`).
    *Rejected:* free-form Markdown output; retrieval over a vector store.
11. **0068 — First default grant on the `employee` role (`meetings:access`)**
    (`docs/adr/0068-default-employee-grant-meetings-access.md`). Forced by the owner decision
    behind AC-10.8. *Rejected:* admin-assigned access as for every other tool (specs/004
    posture), overruled because every employee must be able to record without an admin step.

## Proposed spec amendments (for the owner, before plan approval)

- **A1 (AC-2.8).** "has received no audio **or keep-alive** for 2 minutes reads as
  `interrupted`". Without it, a pause longer than 2 minutes reads `interrupted`.
- **A2 (AC-2.8 / AC-2.9 / AC-4.11).** At most 30 s are lost for audio captured while
  connected. Audio captured while offline survives only as long as the tab does, because
  AC-4.11 forbids keeping it on the device.
- **A3 (AC-11.8).** `unlinked` and `deleted` notices carry no title or date-time, so nothing
  with a title outlives a deletion (AC-4.6).
- **A4 (AC-5.8).** A creator who no longer holds `meetings:access` can read the meeting and
  delete it or its recording, and nothing else ("the creator can do everything" assumes the
  default grant).

## Amendments 2026-11-04 (design stage)

Gaps raised in `specs/021-meetings/design.md` § Gaps, decided by the orchestrator on the
user's delegation. The spec's ACs are unchanged.

- **G1: source lock.** The source locks only once audio, a chunk or text exists, not on
  consent. Switching a draft to `text` clears the attestation; recorded ↔ uploaded keeps it.
  The meeting view gains `can.changeSource` and `can.changeLanguage`. Changed: § API
  contracts (`Meeting.can`, `PATCH /meetings/:id`), § Data model (consent CHECK note),
  tests AC-2.3 and AC-3.5.
- **G2: linking an existing meeting from the host panel.** The panel adds "Link an existing
  meeting", backed by a new `GET /hosts/:app/:type/:id/linkable-meetings` (creator-only,
  not frozen, not already on this entity) and the existing `PATCH host` (same resolve check
  as starting). There is no host-side search API, and unlinking stays on the meeting page.
  This is the UI path for AC-1.7, AC-11.8 "later", AC-14.1 "or later linked" and AC-14.7.
  Changed: § Host integration contract (panel), § API contracts (Hosts), tests AC-1.7,
  AC-14.1 and AC-14.7.
- **G3: offline loss shown to the creator (AC-2.9).** Heartbeats and confirms carry
  `capturedMs`. `recording_session.capturedMs` stores it, and the view exposes
  `recording.lostMs` (nullable lower bound; a fallback sentence when it is null). Changed:
  § Browser capture, § Data model, § API contracts (Capture, `Meeting`), test AC-2.9.
- **G4: per-summary `can: { edit, delete, retry }`.** Changed: § API contracts (Summaries),
  tests AC-7.7 and AC-7.8.
- **G5: UI permission hints.** The UI uses `apps` and `{resource, action}` pairs from
  `PermissionsResult` as hints only. auth gets a catalog test that fails on duplicate
  resource keys. Changed: § Authorization, tests AC-4.7 and AC-8.3.
- **G6: host-visibility hint.** `labels.<lang>.visibilityHint` is added to the registry and
  to `GET /hosts`. Changed: registry, Hosts table, test AC-5.5.
- **G7: AC-14.8 copy comes from the host.** The sentence is `labels.<lang>.noticeFailed`, a
  full sentence rather than an entity word so that Italian articles and gender work. For the
  CRM it is exactly AC-14.8's text. This is a wording observation only; no AC change is
  needed. Changed: registry, test AC-14.8.
- **G8: template concurrency.** `PATCH /templates/:id` requires `If-Match` (ADR-0038).
  Changed: § API contracts (Templates), § Data model note, test AC-8.3.
- **G9: no `appId` filter on the participant directory.** Changed: § Authorization, test
  AC-5.1.

Affected ADRs (not edited here):
- **ADR-0060:** the panel now also offers "Link an existing meeting" and reads one more
  meetings-api route. Props and the loading seam are unchanged.
- **ADR-0059:** the registry's public part gains `visibilityHint` and `noticeFailed`. The
  two host endpoints (contract v1) are unchanged.
- **ADR-0066:** it should state that Meetings calls the directory *without* ADR-0055's
  `appId` filter. Its current text only says the filter "can" narrow.

## Amendment 2026-11-05 (implementation, source: T94)

- **Speaker names in summaries.** The `summarize` job runs without a caller JWT, so it cannot
  call `auth POST /authz/users/identities` (ADR-0039 forwards the caller's token). Without a
  fix, speakers mapped to Operai participants would read "Speaker n" in summaries.
  - The fix: `POST /meetings/:id/summaries` (T40) resolves the names while it still has the
    caller's token. Every Operai-mapped speaker label is looked up, fail soft (unknown,
    deleted or outage → "Speaker n"). The names are stored as `Summary.template.speakerNames`
    (`{ [speakerKey]: string }`), next to the template sections inside the existing snapshot
    JSON, so no migration is needed. The job uses only that map.
  - Regenerate re-resolves the names; retry keeps the stored ones. Names in a stored summary
    are therefore as of generation, the same rule as the template snapshot (AC-7.5).
  - AC-7.10 is unaffected: the names come from the meeting's own participants, not from host
    data.
  - Changed: § API contracts (Summaries), § Data model (`Summary`), tests AC-7.1 and AC-7.4.
- **Bedrock startup check.** Retention `none` is verified in the home Region **and every
  destination Region** of the inference profile, which needs
  `bedrock:GetAccountDataRetention` in each. This is stricter than ADR-0061's wording ("the
  region's"); not edited here.
  - Changed: § AI providers (startup checks), § Environment (IAM), test AC-4.9.

## Amendment 2026-11-05 (implementation, source: T19–T34)

1. **`MeetingRow.role` gains `"host_reader"`** for a host-visible reader's row in a host's own
   list (`GET /hosts/:app/:type/:id/meetings`). My meetings never returns it. Changed:
   § API contracts (types), test AC-11.2.
2. **High-frequency recording routes skip the live frozen lookup.**
   - Chunk confirm, upload-url re-mint and heartbeat check creator + `meetings:access` only
     ("creator-control (light)").
   - The reason: `auth` rate-limits `/authz/users/identities` at 120 calls per 10 min per
     caller, and a recording makes about 8 such calls a minute.
   - Start, stop, process, discard, upload, text and transcript edits keep the full live
     check.
   - **Accepted residual:** a creator deactivated mid-recording can keep uploading chunks
     until the next full-check call (stop or process refuses with 403 `frozen`). This is
     bounded by the 3 h cap, in the same family as ADR-0012's residual JWT window; the
     uploaded audio then sits in a frozen meeting and expires with the bucket rule.
   - Changed: § API contracts (Capture), test AC-2.11.
3. **Additive contract details:**
   - problem codes `not_interrupted`, `no_audio`, `not_recording`, `wrong_source`,
     `not_draft`, `not_editable`, `not_ready`, `in_progress`, `media_unavailable`,
     `participant_not_in_meeting` (each a 409/422 refinement of a state the plan already
     refuses; the UI's code → copy map in meetings-ui `lib/errors.ts` must list them all);
   - title search escapes `ILIKE` wildcards (`likeLiteral`);
   - limits: chunk `seq` ≤ 19,999, speaker label ≤ 100 characters, segment text ≤ 10,000
     characters;
   - the linkable-meetings list resolves host labels for rows linked elsewhere (batched,
     fail soft).

   Changed: § API contracts (Conventions, Hosts, Capture, Transcript), tests AC-2.11, AC-6.2
   and AC-10.2.

Not recorded: the 48 kHz decode rate of Ogg Opus seen by `ffprobe`. The plan only states the
encode arguments (`-ar 16000`), not a probed rate, so nothing in it is wrong.

## Amendment 2026-11-05 (provider change: Google Cloud; source: user decision)

> **Approved by the user 2026-11-05.** Q1 decided: BatchRecognize with diarization, accepting that
> Google may keep the async transcript result for ~5 days (spec Constraint amended accordingly).

> **Scope.** The user decided on 2026-11-05 to run both AI steps on Google Cloud under one contract:
> transcription by **Cloud Speech-to-Text v2, model Chirp 3**, and summaries and Q&A by **Claude on
> Vertex AI** (Anthropic models served by Google), EU. Azure AI Speech and Amazon Bedrock are
> dropped: no contract will be signed and nothing was provisioned. This amendment replaces D-5's
> provider choice, its startup checks, the provider env rows and the Bedrock-specific risks. It
> keeps everything else: the spec's guarantees (EU/CH processing, no retention, no training,
> AC-4.9 startup refusal, fake refused in production), the two interfaces, ADR-0061's principle and
> failure shape, ADR-0067's structured output and eval gate, and ADR-0062's runner. Plan
> `status:` is untouched; the orchestrator handles approval. Vendor facts were read from Google's
> documentation on 2026-11-05 (sources at the end of this section). Google now publishes the
> Vertex AI generative docs as "Gemini Enterprise Agent Platform"; the API hosts are unchanged.

### G-0 Spec check

- **No AC, constraint or open item names Azure, Bedrock, Microsoft or AWS.** The spec is
  provider-neutral: Constraints say "provider choice is the architect's", and AC-4.1, AC-4.9 and O3
  say "EU or Switzerland". The consent notice (`CONSENT_NOTICE_VERSION = "2026-11-01"`) names no
  processor, so the notice version needs no bump. No spec edit is required.
- **Two items need the PO and the data-protection lead.** They are not edits; see § G-16.
  - Q1: a documented ~5-day storage of async transcripts by Google, against the Constraint
    "must contractually not retain submitted content beyond the request".
  - A5: an optional AC-6.2 clarification for long recordings transcribed in parts.

### G-1 Architecture delta

```
 meetings-api (Railway EU) ── prepare_audio (unchanged) ──► Railway EU bucket  MEETINGS_S3_*  (audio.ogg, 29-day rule)
      │
      │ transcribe job: audio.ogg ─ffmpeg split (≤ PIECE_MAX_MS)─► parts p1..pN (local temp dir)
      ├─► GCS transient bucket (EU, regional endpoint storage.<loc>.rep.googleapis.com)  gs://<bucket>/transcribe/<meetingId>/<attempt>/
      ├─► Speech-to-Text v2  https://eu-speech.googleapis.com/v2/projects/<p>/locations/eu/recognizers/_:batchRecognize
      │       chirp_3 · one locale · diarization · output to the same GCS prefix (not inline) · poll operation
      │       → read the output JSON → operations.delete → delete the GCS prefix
      ├─► Vertex AI  https://aiplatform.eu.rep.googleapis.com/v1/projects/<p>/locations/eu/publishers/anthropic/models/<m>:rawPredict
      │       Claude, forced tool use (ADR-0067), no cache_control, no server tools
      └─► oauth2.googleapis.com (service-account token exchange; carries no content)
```

- One dedicated Google Cloud project, `MEETINGS_GCP_PROJECT_ID`, holds the Speech API, the Vertex
  model enablement and the transient bucket. Every runtime call uses one service account. The
  project is the unit of the sign-offs in § G-5, so it holds nothing else.
- The Railway bucket stays the only place audio is *kept* (ADR-0063). The GCS bucket is a
  **transient processing hop**: bytes live there only while one transcription attempt runs.
- Rejected:
  - `@google-cloud/speech`: a gRPC client, unproven on Bun, and it hides the request URL that
    the residency check pins. REST through `fetch` is used instead.
  - `@google-cloud/storage`: a large dependency for four JSON-API calls, again REST.
  - Vertex through raw REST: the Anthropic Vertex SDK
    (`@anthropic-ai/vertex-sdk` 1.1.2) gives typed Messages requests. The adapter pins its
    `baseURL`, `authClient` and `maxRetries` explicitly, so none of its environment defaults
    apply.

### G-2 Transcription: Chirp 3 through a transient EU bucket (the key design point)

**Why a bucket at all (verified, not assumed).** Chirp 3 does diarization only in `Recognize` and
`BatchRecognize`; the feature table says only `BatchRecognize`. `Recognize` takes at most
1 minute or 10 MB per request. `BatchRecognize` accepts audio **only as a Cloud Storage URI**: its
`BatchRecognizeFileMetadata.audio_source` is a `gs://` `uri` and nothing else. A 3 h meeting
therefore needs its audio in a GCS bucket for the length of the transcription. That bucket is a new
storage hop, covered by AC-4.9 ("a storage location outside the EU … refuses to start") and by
ADR-0061's "every hop". Alternatives considered:

| Option | Residency / retention | Diarization | Verdict |
|---|---|---|---|
| **BatchRecognize, audio in a transient EU GCS bucket, output written to that bucket** | Bucket in an EU location, reached only through its regional endpoint, rules verified at startup (below). Google documents that the async endpoint does not store input audio. It does store "the resulting transcript … for approximately 5 days to give you time to retrieve the transcript" [G4]; whether that applies with Cloud Storage output is not documented (Q1) | Yes, per file; labels are consistent within one file | **Chosen**, go-live gated on Q1 |
| BatchRecognize with inline output | Same bucket for the input; the transcript is held in the operation, which is exactly the ~5-day storage the FAQ describes | Same | Rejected: it moves the transcript copy from a bucket we control and empty into Google's operation store |
| `Recognize` (sync), inline audio in ≤ 60 s pieces, no bucket | "processes it in memory and does not store any customer data" [G4]: the cleanest retention story | Per minute only, with no label continuity across about 180 pieces, which in practice means no diarization | **Named fallback** if Google cannot confirm Q1. It would give one label per meeting, a visible AC-6.2 regression (see § G-16) |
| `StreamingRecognize` | In memory | Not supported for Chirp 3 | Rejected: no diarization, and the audio must be sent at about real time (3 h takes 3 h) |
| Leave the audio in the Railway bucket and give Google a presigned URL | — | — | Impossible: BatchRecognize accepts only `gs://` |
| Dynamic batching (`processingStrategy: DYNAMIC_BATCHING`) | Same as chosen | Same | Rejected: up to 24 h latency, which breaks the processing target |

**Transient bucket rules.** All of these are verified at startup, and unreadable means refuse (§ G-5 N2):
- **Location** in an EU or CH location: `EU` multi-region or one EU/CH single region; London
  (`EUROPE-WEST2`) is excluded. The allowlist is fixed in code at implementation from Google's
  locations list. `EUROPE-WEST4` (Netherlands, next to Railway Amsterdam) is recommended.
- **Lifecycle:** an enabled `Delete` rule whose only condition is `age ≤ 1` (day), with no
  `matchesPrefix`/`matchesSuffix`/storage-class or other narrowing condition. Lifecycle runs
  asynchronously, so this is a backstop, not the deletion path.
- **Soft delete off:** `softDeletePolicy.retentionDurationSeconds == 0`. GCS enables soft delete
  **by default with 7 days** on every new bucket [G8], so a deleted object would otherwise stay
  recoverable for a week. This is the GCS analogue of ADR-0063's "versioning off".
- **Versioning** not enabled; **no** `retentionPolicy`; `defaultEventBasedHold` false (a hold or
  a retention lock would block deletion).
- **Access:** uniform bucket-level access on, public access prevention `enforced`.
- **Endpoint:** every object call goes to the **regional endpoint**
  `https://storage.<location>.rep.googleapis.com`, derived from the location read at startup,
  never configured. Regional endpoints keep object data at rest *and in transit* in that location
  and refuse the request if the bucket is elsewhere [G7]. The one startup metadata read (bucket
  config) uses the global JSON endpoint; it carries no content. Google's guarantee excludes resource
  metadata, so object names hold identifiers only.
- **Object names:** `transcribe/<meetingId>/<attempt>/in/<n>.ogg` and
  `transcribe/<meetingId>/<attempt>/out/…` (written by Speech). They carry no title and no content
  (AC-4.10).
- **IAM on the bucket only:**
  - the runtime service account: `storage.objects.create/get/list/delete` and
    `storage.buckets.get` (the startup check);
  - the Speech service agent `service-<projectNumber>@gcp-sa-speech.iam.gserviceaccount.com`:
    `storage.objects.get` (reads the parts) and `storage.objects.create` (writes the output);
  - no project-level storage role.

**Flow of one `transcribe` attempt.** It replaces the Azure call in
`meetings-api/src/jobs/handlers/transcribe.ts`; guards, commit and notification are unchanged.
1. Download `audio.ogg` to the per-job temp dir, as today.
2. **Delete** `transcribe/<meetingId>/`. This removes leftovers of any earlier attempt, including
   output written late by an operation whose process died.
3. **Split** (§ G-3) into parts p1..pN with their start offsets.
4. **Upload** each part to `…/<attempt>/in/<n>.ogg` with `ifGenerationMatch=0`.
5. One `batchRecognize` **per part** (Google's best practice is one file per request), all submitted
   together. The body:

   ```json
   { "config": { "model": "chirp_3", "languageCodes": ["<it-IT|en-US>"], "autoDecodingConfig": {},
                  "features": { "diarizationConfig": {} } },
     "files": [{ "uri": "gs://<bucket>/transcribe/<id>/<attempt>/in/<n>.ogg" }],
     "recognitionOutputConfig": { "gcsOutputConfig": { "uri": "gs://<bucket>/transcribe/<id>/<attempt>/out/" } } }
   ```

   - Exactly one language code, never `"auto"` (AC-13.2).
   - `minSpeakerCount`/`maxSpeakerCount` are not sent: Google documents them as "not currently
     used". `maxSpeakersFor` stays in the interface and is ignored by this adapter.
   - No word time offsets, unless the spike (T107) shows speaker labels need them (§ G-3).
   - No denoiser, unless the spike shows it helps mixed mic and tab audio (R3).
6. **Poll** each operation (`GET https://eu-speech.googleapis.com/v2/<operation name>`):
   - every 10 s, backing off to 30 s;
   - a deadline of 45 min per part;
   - the job's lease is heartbeated meanwhile, and a lost lease (`ctx.signal`) aborts.
7. For each finished operation:
   - read `results[uri].cloudStorageResult.uri`, which must start with this attempt's `out/`
     prefix (anything else is refused);
   - read the JSON, **≤ 8 MiB**, else `provider_rejected`;
   - then `operations.delete`, best effort (Google: "the client is no longer interested in the
     operation result").
8. **Map** to `Phrase[]` (§ G-3), then the existing `mapPhrases`. Any part failing fails the whole
   attempt: no partial transcript, AC-6.9.
9. `finally`: **delete** `transcribe/<meetingId>/` (inputs and outputs), whether the attempt
   succeeded or not, and remove the temp dir.

**Explicit deletions extend to the transient prefix.** "Delete recording" (AC-4.5) and "Delete
meeting" (AC-4.6) delete `transcribe/<meetingId>/` in the GCS bucket **together with** the Railway
prefix, **before** any database change. As in ADR-0063, a failure answers 503 and nothing changes.
- **Accepted residual, stated:** a Speech operation still running at deletion time can write its
  output file *after* the delete. That file is a transcript, not audio. It is removed by the
  attempt's own `finally` if the process is alive, otherwise by the next attempt's step 2 or by the
  1-day lifecycle rule (plus Google's lifecycle lag).
- Bound: at most the running part's remaining time plus one day plus lag, with identifiers-only
  names. This is the same family as the residuals accepted for ADR-0012 and in the T19–T34
  amendment.

### G-3 Splitting and stitching

- **Why split.** Google's Chirp 3 page says BatchRecognize is "good for long audio 1 minute to
  1 hour in general, but up to 20 minutes with word-level timestamp enabled". The generic batch
  limit is 8 h per file. Our meetings run to 3 h + 60 s.
  - Default `PIECE_MAX_MS = 60 min`, without word timestamps: a 3 h meeting is 3 or 4 parts.
  - The constant lives in code, not env.
  - The spike (T107) may raise it to the whole meeting, if a 3 h file transcribes and diarizes
    acceptably as one file. Then there is one part and nothing to stitch.
  - It may lower it to 20 min with word offsets, if speaker labels are only returned with them.
  - The code handles N ≥ 1 parts identically.
- **Where to cut.** Inside the transcribe job, under the process ffmpeg slot (§ G-11, T98):
  - `ffmpeg -protocol_whitelist file -f ogg -i audio.ogg -af silencedetect=noise=-35dB:d=0.5
    -f null -` finds silences; this is a decode pass, about 10–30 s for 3 h of 16 kHz mono Opus;
  - each cut is the longest silence ≥ 0.5 s within the 90 s before each `PIECE_MAX_MS` mark, else a
    hard cut at the mark;
  - `ffmpeg … -c copy -f segment -segment_times <cuts> -segment_list parts.csv` writes the parts.
    This is a stream copy, no re-encode, cut at Opus packet boundaries (20 ms);
  - `parts.csv` gives the authoritative start offset of each part.
  - The same hardening as ADR-0064 applies: `-protocol_whitelist file`, pinned `-f ogg`, a minimal
    child env, a timeout, and the temp dir. The input is our own derived `audio.ogg`, never a
    user-chosen file. ADR-0064's bounded-read rule is not widened; this is a note for it (§ G-15).
- **Times.** Chirp 3 documents utterance-level timestamps only for streaming. A batch result
  carries `resultEndOffset`, and word offsets only when enabled. So a segment's times are:
  - `startMs` = part offset + the previous result's `resultEndOffset` within the part (0 for the
    first);
  - `endMs` = part offset + its own `resultEndOffset`.
  - Times are therefore at result granularity and never *later* than the speech, so AC-6.5's
    "play from that point" starts at or slightly before the words. With word offsets on (spike
    outcome), the times are exact.
- **Speakers within a part.** Diarization labels are per *word* (`words[].speakerLabel`). A result
  whose words change speaker is split into consecutive runs, one segment per run. Every run takes
  the result's start, the same never-late rule.
- **Speakers across parts: labelled per part, never claimed to be the same person.** The adapter
  emits `speaker = "p<n>:<label>"`. The existing `mapPhrases` then numbers keys by first
  appearance across the whole meeting, so part 2's voices become "Speaker 4", "Speaker 5" and so on.
  `segments.ts` is unchanged.
  - Rejected: carrying labels over by ordinal (part 2's "1" ≠ part 1's "1"). That would put one
    person's words in another's mouth, in the transcript **and in every summary** built from it,
    which is worse than one person under two labels.
  - Rejected: voice-embedding matching across parts. That is new processing of voice
    characteristics (biometric-adjacent personal data), which the spec never asked for.
  - Named follow-up, not this release: overlapping parts by about 2 min and mapping labels by
    aligning the overlap's words. Trigger: users routinely merging labels on long meetings.
- **Merging is renaming, which already works.** `speaker_label` has no unique constraint on
  `participantId`, so the creator can map "Speaker 1" and "Speaker 4" to the same participant (or
  the same text). Both then read as that name in the transcript, in the download and in summaries'
  `speakerNames` (AC-6.2, T94 amendment). No new endpoint is needed.
- **What the UI shows** (T108). For a transcript with more than one part:
  - a non-blocking `Banner` (info) above the transcript: "This recording was transcribed in
    {n} parts. Speakers are numbered separately in each part, so one person can appear under two
    labels. Rename a label to merge them." The Italian is in the strings module;
  - a divider before the first segment of each part after the first: "Part {n} · {hh:mm:ss}".
  - A single-part transcript shows neither.

> **T107 spike outcome, 2026-11-05** (real sandbox project, Chirp 3 `eu`, synthetic it/en audio; about 6.3 h transcribed). (1) Google refuses a BatchRecognize file over 20 min (INVALID_ARGUMENT, billed 0 s); the "1 h" in the docs is wrong for Chirp 3. (2) A batch output has one result per file, no `resultEndOffset`; times exist only as word offsets, so `WORD_OFFSETS = true` (speaker labels do not need them). Word offsets are partly unreliable (garbled first sentence, sentence-final words ending early, one word at 9985 s), so a word is trusted only when plausible and within its part (+5 s), and a run takes its first and last trusted word. (3) At 18-19 min parts Chirp 3 omitted 19-45 % of the speech in 2 of 4 parts; at 10 min, 98-103 % in 6 of 7 parts of one file and 3 of 19 parts at 72-84 % in another (synthetic repetitive audio; not validated on real meetings). `PIECE_MAX_MS` = 10 min; 3 h = 19 parts (`MAX_PARTS` 32 covers 5.3 h). A hole detector (silencedetect list vs word timeline) is a named follow-up. (4) Latency: Google-side per 10 min part median 72 s, p95 85 s, max 87 s (n=25); whole job for 1-3 h 108-169 s from a laptop, independent of duration while parts run in parallel; no throttling at 19 concurrent operations. (5) `eu` serves `cacheConfig` (200, `disableCache:true`); `fetchPublisherModelConfig` answers 404 for a never-configured model; N2-N4 pass on the sandbox. (6) Silence and noise come back as a lone `[`; the adapter treats it as no speech. (7) `roles/speech.client` lacks `speech.operations.delete`; the best-effort delete returns 403. (8) Sonnet 5.5 rejects forced `tool_choice` (400 "type tool and any are not supported for this model"); `thinking: disabled` is also rejected. Minimal IAM (to confirm with Policy Troubleshooter): Speech `speech.recognizers.recognize`, `speech.operations.get`, `speech.operations.delete`; Vertex `aiplatform.endpoints.predict`, `aiplatform.cacheConfigs.get`, plus the not-yet-identified permission behind `fetchPublisherModelConfig` (keep `roles/aiplatform.user` until named); transient bucket `storage.buckets.get`, `storage.objects.create/get/list/delete`; Speech service agent `storage.objects.get/create` on the bucket. Open drift from this spike: D3 (completeness) and D4 (forced tool use) await the owner's decision.

### G-4 Language model: Claude on Vertex AI, EU

- **Endpoint.** The `eu` multi-region,
  `https://aiplatform.eu.rep.googleapis.com/v1/projects/<p>/locations/eu/publishers/anthropic/models/<model>:rawPredict`.
  - Google: the `eu` endpoint "strictly covers data residency within EU member states"; Switzerland
    and the UK are excluded, which is within the spec.
  - Google's residency table [G2] lists every current Claude model for the EU multi-region.
    Belgium (`europe-west1`) is listed only for older models (Opus 4.5/4.6, Sonnet 4.6, Haiku 4.5),
    and Netherlands (`europe-west4`) for none.
  - Multi-region endpoints serve "all Claude models with versions 4.7 and later".
  - **The global endpoint is refused**: it "don't provide any data residency guarantees".
- **Model.** Pinned in `MEETINGS_VERTEX_MODEL_ID`, chosen by the live eval (ADR-0067 gate), as
  today.
  - **Excluded: Claude Fable and Claude Mythos (all versions).** Vertex designates them "Advanced
    AI", with prompt **and response** logging "for up to 30 days", which "may not be possible" to
    opt out of [G5]. This is the same exclusion ADR-0061 made for Bedrock's `aws_review`.
  - Opus ≥ 4.7 and Sonnet ≥ 5 are in Advanced AI scope only with `advanced_ai_enabled: true`
    (Anthropic's Cyber Verification Program), which this service never sends.
  - Recommendation: evaluate a Sonnet 5.x first (cost, latency), and Opus only if the evals fail.
- **Request.** The Messages API through `@anthropic-ai/vertex-sdk`:
  - `new AnthropicVertex({ region, projectId, baseURL: <derived>, authClient: <JWT from the
    explicit key>, maxRetries: 0, timeout: 60_000 })`;
  - `messages.create({ model, system, messages, max_tokens, tools: [<the one output schema>],
    tool_choice: { type: "tool", name } })`.
  - **Never** `cache_control`: Claude prompt caching on Vertex is explicit per request and is
    stored 5 min to 1 h. **Never** server tools (web search, code execution), `advanced_ai_enabled`
    or any `betas`.
  - An explicit `baseURL` matters: the SDK otherwise reads `ANTHROPIC_VERTEX_BASE_URL` and
    `CLOUD_ML_REGION` from the environment. An explicit `authClient` stops google-auth-library
    falling back to Application Default Credentials.
  - The reply must have `stop_reason: "tool_use"` and a `tool_use` block with the forced name,
    else `invalid_output`, as today. `prompts/*`, the validators and `fakeLanguageModel.ts` are
    unchanged.
- Rejected:
  - the global endpoint (no residency);
  - `europe-west1` as the default (current 4.7+ models are not served there);
  - Gemini on Vertex for summaries (not the user's decision; a different model family would need
    its own eval baseline, and Gemini's implicit caching is on by default);
  - Vertex prompt caching (stored data, and nothing at this size needs it).

### G-5 Residency and retention: what is verified at startup, what is signed off

The ADR-0061 posture carries over: everything Google exposes through an API is **read at startup**,
and unreadable, absent or wrong means **exit 1**. What Google does not expose becomes a **recorded
go-live sign-off** with an owner and a date, re-attested quarterly and on any change to the project.
Startup refusals name the check, never a value (as today).

| # | Check | How | Where |
|---|---|---|---|
| S1 | Speech location is `eu` (allowlist: `eu` only; Chirp 3 is GA in `eu` and `us` only) | sync, env | `env.ts` / `residency.ts` |
| S2 | Vertex location in `{eu, europe-west1, europe-west4}`; `global`, `us` and anything else refused | sync, env | same |
| S3 | `MEETINGS_VERTEX_MODEL_ID` matches `^claude-[a-z0-9.@-]+$` and contains neither `fable` nor `mythos` | sync, env | same |
| S4 | The service-account key decodes (base64 → JSON), `type == "service_account"`, `project_id == MEETINGS_GCP_PROJECT_ID`, `client_email` and `private_key` present | sync, env | same |
| S5 | `ANTHROPIC_VERTEX_BASE_URL` is not set (an ambient base-URL override is refused even though the adapter passes its own) | sync, env | same |
| S6 | `MEETINGS_AI_PROVIDER=fake` refused in production (unchanged) | sync, env | same |
| N1 | Railway audio bucket: 29-day rule, versioning (unchanged, ADR-0063) | network | `startupChecks.ts` |
| N2 | GCS transient bucket: location allowlist, lifecycle `Delete` `age ≤ 1` unfiltered, versioning off, soft delete `0`, no retention policy, no default event hold, uniform access, public access prevention enforced (§ G-2) | network: `GET storage/v1/b/<bucket>?fields=location,lifecycle,versioning,softDeletePolicy,retentionPolicy,defaultEventBasedHold,iamConfiguration` | same |
| N3 | Vertex data caching **disabled for the project**: `GET …/v1/projects/<p>/cacheConfig` must answer `disableCache: true`. `DURABLE` or `EPHEMERAL` refuses. Google documents implicit caching for its own Gemini models; the check is required regardless, because the setting is project-wide and costs one read. Google's sample serves this read from a `us-central1` host; the spike confirms whether the `eu` host serves it. Either way it is a control-plane read that carries the project id and no content, the same class as the token exchange | network | same |
| N4 | Vertex request-response logging **not enabled** for the exact location and model: `GET …/v1beta1/projects/<p>/locations/<loc>/publishers/anthropic/models/<model>:fetchPublisherModelConfig`. A 404 means "no config, default disabled" per Google [G6] and passes; `loggingConfig.enabled == true` or `enableOtelLogging == true` refuses; any other error refuses | network | same |
| H1 | **Speech-to-Text data logging not enrolled** for the project. It is opt-in, a console toggle; the v2 `Config` resource exposes only `kmsKeyName`, so it **cannot be read by API** | sign-off | infra README checklist |
| H2 | **Contract:** wellD's use is under the Google Cloud **Master Agreement** + CDPA, not the online Terms of Service. Only then is the abuse-monitoring prompt logging (up to 90 days for flagged prompts) and human review exempt "by default" [G5]. Also written confirmation that it does not apply to Claude on Vertex | sign-off (O3) | same |
| H3 | **No consent to the Advanced AI Safety Addendum** in the project, and no Advanced AI model enabled. Consent is per project, in the console, and needs `aiplatform.consents.update`, which the runtime SA does not hold | sign-off | same |
| H4 | **Written confirmation from Google on Q1:** with `gcsOutputConfig`, the Speech service keeps no copy of the transcript after the operation, or keeps it for how long. The FAQ says ~5 days for async results | sign-off, **blocks go-live** (§ G-16) | same |
| H5 | **Anthropic's terms:** enabling Claude in Model Garden accepts Anthropic's Commercial Terms of Service, which govern use of Anthropic models on Vertex [G5]. The DPL confirms this does not make Anthropic a processor of meeting content. Google states prompts and responses "are not shared with third-parties … including partner models" [G9] | sign-off (O3) | same |
| H6 | Cloud Audit Logs **Data Access** for `speech`, `aiplatform` and `storage` do not record request payloads (checked at provisioning) | sign-off | same |

- **Grounding is not used.** It is enforced in code, not signed off: the request carries exactly
  one tool, the output schema, and a unit test asserts it (T100).
- **Defence in depth**, recommended at provisioning and not relied on by the code:
  - an organization policy restricting resource locations to EU;
  - Google's organization policy blocking global-endpoint usage;
  - a key-expiry policy on service-account keys;
  - a dedicated project;
  - a runtime SA with no `setPublisherModelConfig`, no `cacheConfig` update, no consents, no
    `serviceusage` and no IAM permissions.

### G-6 Credentials — recommendation: a service-account key for the runtime, Workload Identity Federation for CI

- **Runtime (Railway): one service account, `meetings-api@<project>.iam.gserviceaccount.com`, JSON
  key in `MEETINGS_GCP_SERVICE_ACCOUNT_KEY` (base64), from 1Password.**
  - Workload Identity Federation needs an identity token from the workload's platform. Railway
    publishes none: its OIDC is "Login with Railway" for *users* and dashboard SSO, read in
    docs.railway.com on 2026-11-05. A token minted by our own `auth` service would make `auth`'s
    key the Google credential, which is no better.
  - Least privilege, as a custom role on the project unless noted:
    - Speech: recognize on `recognizers/_`, `operations.get`, `operations.delete`;
    - Vertex: `aiplatform.endpoints.predict` on publisher models, read of `cacheConfig`, read of
      `publisherModelConfig`;
    - the bucket-level storage bindings of § G-2.
    - Exact permission names are confirmed at provisioning with Policy Troubleshooter (T106).
  - Rotate every 90 days under a key-expiry policy. The key is never logged; env-doctor treats it
    as secret.
  - **Escalation trigger:** Railway ships workload OIDC, then move the runtime to WIF and delete the
    key.
- **Live eval (GitHub Actions): Workload Identity Federation** with GitHub's OIDC token
  (`id-token: write`, `google-github-actions/auth` pinned by SHA). It uses a **separate eval
  service account** with Vertex predict only (no Speech, no bucket), so the CI secret is not a key.
  The evals' content is synthetic.
- Rejected:
  - Application Default Credentials (ambient, ADR-0061 failure shape);
  - one key for runtime and CI;
  - a Google API key (Vertex partner models and Speech batch need OAuth).

### G-7 Environment contract delta (meetings-api)

| Removed | Added | Notes |
|---|---|---|
| `AZURE_SPEECH_REGION`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_ENDPOINT` | `MEETINGS_SPEECH_LOCATION` | `eu` (S1); the endpoint `https://<loc>-speech.googleapis.com` is derived, never configured |
| `BEDROCK_REGION` | `MEETINGS_VERTEX_LOCATION` | `eu` recommended (S2); the base URL is derived (`aiplatform.eu.rep.googleapis.com` for `eu`, `<region>-aiplatform.googleapis.com` otherwise) |
| `BEDROCK_MODEL_ID` | `MEETINGS_VERTEX_MODEL_ID` | pinned; changing it needs a green live eval (ADR-0067); S3 |
| `MEETINGS_AWS_ACCESS_KEY_ID`, `MEETINGS_AWS_SECRET_ACCESS_KEY` | `MEETINGS_GCP_SERVICE_ACCOUNT_KEY` (secret), `MEETINGS_GCP_PROJECT_ID` | S4 |
| — | `MEETINGS_GCS_TRANSIENT_BUCKET` | the transient bucket's name; its location is read at startup (N2) |

- All six are required with `MEETINGS_AI_PROVIDER=real`. With `fake` they are optional and, when
  set, validated (today's posture). The fake transcriber never touches the bucket.
- Env-doctor:
  - `meetings-api` required keys swap as above;
  - `SECRET_VARS` loses `AZURE_SPEECH_KEY` and `MEETINGS_AWS_*` and gains
    `MEETINGS_GCP_SERVICE_ACCOUNT_KEY`;
  - the seven removed names are flagged as **retired** if present, the `retiredToken` pattern, so a
    stray Azure or AWS key in a deployed service is visible.
- The production template gets
  `MEETINGS_GCP_SERVICE_ACCOUNT_KEY=${OP:AIScream/OperAI - Meetings GCP SA/key-base64}` and
  `MEETINGS_VERTEX_MODEL_ID=SET-ME-pinned-model-id` (placeholder until the live eval is green).
- Eval workflow variables:
  - `MEETINGS_EVAL_GCP_WIF_PROVIDER`, `MEETINGS_EVAL_GCP_SERVICE_ACCOUNT`,
    `MEETINGS_EVAL_GCP_PROJECT_ID`, `MEETINGS_EVAL_VERTEX_LOCATION`,
    `MEETINGS_EVAL_VERTEX_MODEL_ID` (vars, none secret);
  - they replace `MEETINGS_EVAL_AWS_*` and `MEETINGS_EVAL_BEDROCK_*`;
  - `meetings-eval.yml`'s credential guard regex becomes
    `^(MEETINGS_GCP_|MEETINGS_VERTEX_|MEETINGS_SPEECH_|GOOGLE_|CLOUDSDK_|ANTHROPIC_|AWS_|AZURE_)`.

### G-8 Error mapping into the existing failure codes

The closed sets stay: `TranscriptionFailureCode` = `audio_unreadable | provider_unavailable |
provider_rejected | too_long` and `LanguageModelFailureCode` = `provider_unavailable |
provider_rejected | invalid_output`. UI copy, `failureCode` values and AC-6.9/7.9/9.6 behaviour do
not change. Provider `message` text is never parsed, logged or stored; only HTTP status, gRPC
`code` (numeric `google.rpc.Status.code`) and our own outcomes are used.

| Source | Condition | Code | Transient |
|---|---|---|---|
| Token exchange (`oauth2.googleapis.com`) | network, timeout, 5xx | `provider_unavailable` | yes |
| | 400/401 (`invalid_grant`: revoked or expired key) | `provider_rejected` | no |
| GCS (upload, read, list, delete) | network, timeout, 408, 429, 5xx | `provider_unavailable` | yes |
| | 401/403/404 (permission, bucket gone) | `provider_rejected` | no |
| | output object > 8 MiB, or `cloudStorageResult.uri` outside the attempt's prefix | `provider_rejected` | no |
| `batchRecognize` / operation GET (HTTP) | network, timeout, 408, 429, 5xx | `provider_unavailable` | yes |
| | 400/403/404 | `provider_rejected` | no |
| Finished operation or per-file `error.code` | 4 DEADLINE_EXCEEDED, 8 RESOURCE_EXHAUSTED, 10 ABORTED, 13 INTERNAL, 14 UNAVAILABLE | `provider_unavailable` | yes |
| | 3 INVALID_ARGUMENT on a **file** (cannot decode) | `audio_unreadable` | no |
| | any other code (5, 7, 9, 16, …) | `provider_rejected` | no |
| Our poll deadline (45 min per part) | | `provider_unavailable` | yes |
| Output JSON not the expected shape | | `provider_unavailable` | yes (today's "200 that is not the expected JSON") |
| ffmpeg split of our own `audio.ogg` | non-zero exit or timeout | `audio_unreadable` | no |
| Every part returns no results | | outcome `noSpeech` (AC-6.7) | — |
| Vertex `rawPredict` | network, timeout, 408, 429, 500, 502, 503, 504, 529 (overloaded) | `provider_unavailable` | yes |
| | 400, 401, 403, 404 (model not served at that location), 413, 422 | `provider_rejected` | no |
| | 200 without `stop_reason: "tool_use"` and the forced tool block | `invalid_output` | yes (unchanged) |

`too_long` is still decided upstream by `prepare_audio` (ADR-0064 round 3); Google is never sent
more than 3 h + 60 s. A retry re-runs **all** parts: no per-part result is stored between attempts,
because that would be a partial transcript at rest.

### G-9 Rate limits, quotas and timeouts

- **Speech v2, per region, per project (Google, 2026-10-26):**
  - batch recognition 150 requests per 60 s;
  - operation requests 150 per 60 s;
  - at most 5 files per batch request (moving to 1), each ≤ 8 h.
  - Our worst case is 2 concurrent jobs per process × 4 parts, polled at most every 10 s, which is
    48 operation GETs a minute and 8 batch requests. It is below quota with no increase.
- **Vertex, Claude, EU multi-region (Google's quota table, 2026-11-05; confirm in the project
  console at provisioning):** per base model, QPM 1,000–1,500 and input TPM 10–15 M. The 30-per-hour
  per-user AI limit (AC-13.4) and the runner's concurrency keep usage orders of magnitude below. A
  429 is transient, so the runner backs off and an ask turn shows Retry.
- **Timeouts:**
  - Vertex 60 s per call (unchanged; the ask route's 90 s wraps it);
  - GCS 2 min per part upload;
  - Speech poll deadline 45 min per part;
  - no SDK retries (the runner owns retry, ADR-0062).
- **Processing-time target unchanged** (≤ 3 min + 0.2 × audio duration p95); parts run in
  parallel. The spike (T107) measures it from Railway Amsterdam and replaces R2's Azure spike.

### G-10 Cost note (ops estimate; confirm prices at provisioning)

- **Speech-to-Text v2 standard recognition:** USD 0.016 per minute for the first 500,000
  minutes/month, about **USD 0.96 per audio hour** and ≤ USD 2.88 per 3 h meeting. Billed per second
  of audio successfully processed; server errors are not billed.
  - A retry re-runs all parts, so the worst case is × 3 attempts.
  - Dynamic batching is cheaper but rejected (24 h latency).
- **Claude on Vertex:** the pinned model's per-token price. Google notes "a price difference
  depending on the endpoint type", so multi-region may cost more than global; global is not an
  option. Volumes as before (≤ ~50 k input tokens per summary for 3 h).
- **GCS transient:** negligible (≤ ~45 MB per meeting for minutes).
- Control-plane reads at startup: free.

### G-11 Data model, API contract and code delta

- **Migration** (new, meetings-api; the existing `20261104232300_init` is never modified): `meeting`
  gains `transcriptPartStartsMs Int[] NOT NULL DEFAULT '{}'`.
  - It is written in the transcribe commit, together with the segments: `[0]` for one part,
    `[0, t2, …]` for several.
  - It is reset by the same replace-never-append rule on a retry, and stays `{}` for `text`
    meetings and `noSpeech`.
- **Contract:** `GET /meetings/:id/transcript` gains `parts: { index: number /* 1-based */, startMs:
  number }[]`. It is `[]` for text meetings and `noSpeech`, and ≥ 1 entry otherwise. Additive;
  `speakers[].label` is unchanged.
- **Interfaces:**
  - the `TranscriptionOutcome` `segments` variant gains `partStartsMs: readonly number[]`
    (non-empty, first element 0), and `FakeTranscriber` returns `[0]` unless scripted;
  - `Transcriber.transcribe(...)` keeps its signature;
  - `LanguageModel` is unchanged.
- **Files:**
  - deleted: `src/ai/azureSpeech.ts`, `src/ai/bedrock.ts` and their tests;
  - new: `src/ai/googleSpeech.ts`, `src/ai/vertexClaude.ts`, `src/lib/google/auth.ts`,
    `src/lib/google/transientStorage.ts`, `src/media/split.ts`, `src/media/ffmpegSlot.ts`;
  - changed: `src/lib/env.ts`, `src/lib/residency.ts`, `src/lib/startupChecks.ts`,
    `src/ai/transcriber.ts`, `src/ai/languageModel.ts`, `src/jobs/handlers/transcribe.ts`,
    `src/jobs/runner.ts`, `src/meetings/delete.routes.ts`, `src/audio/audio.routes.ts`,
    `src/transcript/transcript.routes.ts`, `evals/run.ts`, `package.json`.
- **Dependencies:** `@aws-sdk/client-bedrock` and `@aws-sdk/client-bedrock-runtime` are removed.
  `@anthropic-ai/vertex-sdk` (with `@anthropic-ai/sdk`) and `google-auth-library` are added, all
  pinned. `@aws-sdk/client-s3` stays for the Railway bucket.
- **ffmpeg exclusivity moves from job kind to a process slot.** Today the runner refuses to run two
  `prepare_audio` jobs at once (`FFMPEG_KIND`). The transcribe job now also runs ffmpeg, but only
  for seconds before it waits up to 45 min on Google, and a kind-level exclusion would block every
  `prepare_audio` for that whole wait.
  - So `withFfmpegSlot()` (one per process) wraps each ffmpeg invocation in `prepare_audio` and in
    the splitter. ADR-0064's "one ffmpeg at a time per process" holds exactly; ADR-0062's
    concurrency of 2 is unchanged.

### G-12 Test strategy delta

- **Fakes stay.**
  - `FakeTranscriber` and `FakeLanguageModel` drive every integration and e2e test
    (`MEETINGS_AI_PROVIDER=fake`); no test calls Google.
  - The fake transcriber gains a scriptable multi-part outcome, so the transcribe job, the
    transcript route and the UI (fakeApi) can exercise `parts`.
- **Adapter unit tests on recorded fixtures.**
  - `test-fixtures/google-speech/*.json`: operation, batch result and error bodies. They are first
    hand-built from Google's REST reference (T97). The spike (T107) replaces them with responses
    recorded from **synthetic** Italian and English audio, scrubbed of project numbers.
  - `fetch` is stubbed; nothing reaches Google.
  - Speech cases:
    - one part;
    - three parts (offsets, per-part speaker namespacing, a result whose words change speaker);
    - no results;
    - each row of § G-8;
    - poll deadline;
    - a lost lease aborting the poll;
    - the output URI outside the prefix;
    - an output over 8 MiB;
    - the request body (one language code, never `auto`, `chirp_3`, `gcsOutputConfig`, no speaker
      counts);
    - `operations.delete` called;
    - **the prefix deleted in `finally` on success and on every failure**.
  - Vertex cases:
    - the host is `aiplatform.eu.rep.googleapis.com` and the path names `locations/eu`, even with
      `ANTHROPIC_VERTEX_BASE_URL`/`CLOUD_ML_REGION` set in the process env;
    - `maxRetries: 0`;
    - exactly one tool, `tool_choice` forced;
    - no `cache_control`, `advanced_ai_enabled`, `betas` or server tools anywhere in the body;
    - each row of § G-8.
- **Splitter:**
  - unit tests on cut selection, from synthetic silence lists;
  - a real-ffmpeg test (the `normalize.real.test.ts` pattern, skipped without ffmpeg) splits a 75 s
    fixture with `PIECE_MAX_MS` overridden to 30 s, and checks offsets from `parts.csv` and the
    whitelist flags.
- **Startup checks** (the AC-4.9 row):
  - stubbed bucket metadata, failing each N2 property in turn, including soft delete 7 d, a
    `matchesPrefix` rule, age 2, `EUROPE-WEST2` and unreadable;
  - `cacheConfig` `DURABLE`, `EPHEMERAL`, `disableCache: true` and 403/500;
  - `fetchPublisherModelConfig` 404 (passes), `enabled: false` (passes), `enabled: true`,
    `enableOtelLogging: true` and 500/403 (all refuse);
  - env cases S1–S6.
- **Deletion:** `DELETE /meetings/:id` and `DELETE /meetings/:id/audio` delete the transient prefix
  first; a transient-storage failure gives 503 with nothing changed (the AC-4.5 and AC-4.6 rows).
- **Live eval:** `bun run eval --live` builds the Vertex model (the location and model checks
  S2/S3 apply) and runs the same fixtures. `meetings-eval-live.yml` authenticates by WIF. It stays
  the release and model-change gate (ADR-0067).

Changed AC rows (replacing the text of the table above for these ACs):

| AC | Level | What proves it |
|---|---|---|
| AC-4.9 | unit | env S1–S6 and startup N2–N4 refusals listed above, each exit 1 with a value-free message; the Railway bucket checks (N1) unchanged |
| AC-4.5 | integration | delete recording → Railway prefix **and** GCS `transcribe/<id>/` deleted before the DB change; transient-storage failure → 503, audio still listed |
| AC-4.6 | integration | delete meeting → both prefixes first; failure → 503, nothing deleted |
| AC-4.10 | unit + integration | the log-privacy canary passes through both Google adapters (stubbed) and the splitter; object names carry ids only |
| AC-6.1 | unit + integration + component | multi-part outcome → segments in time order with part offsets added; `parts` in the transcript response; divider per part |
| AC-6.2 | unit + integration + component | words with changing `speakerLabel` split into runs; part 2's labels never reuse part 1's keys; mapping two keys to one participant shows one name; banner shown only for > 1 part |
| AC-6.5 | unit | segment `startMs` never later than the result it came from (never-late rule) |
| AC-6.7 | unit + integration | every part empty → `noSpeech`, `parts = []` |
| AC-6.9 | unit + integration | any one part failing → whole attempt `failed` with the § G-8 code, no segments, prefix deleted |
| AC-7.9, AC-9.6 | unit + integration | Vertex 429/529/5xx/timeout → transient; 4xx → `provider_rejected`; no partial `ready` |
| AC-7.10 | unit | the Vertex request carries exactly the one forced tool and no server tool, cache or beta |
| AC-7.12, AC-9.7 | unit + eval | unchanged fixtures; live eval on Vertex |
| AC-13.2 | unit | the batch body has exactly one language code equal to the meeting's locale, never `auto` |

The spike (T107) joins the eval suite as a release gate outside the AC mapping.

### G-13 Risks delta

R2 and R13 are replaced and R1 is restated; R3–R12 and R14–R16 are unchanged.

| # | Risk | Mitigation / early check |
|---|---|---|
| R1 | Google changes residency or retention terms, a pinned model is redesignated "Advanced AI", or a non-readable setting (H1–H6) changes | Startup checks N2–N4 refuse on what is readable. Advanced AI needs a per-project consent the runtime SA cannot give (H3). The model id is pinned and denylisted. Sign-offs are re-attested quarterly and on every project change. A model change needs a green eval |
| R2 | Chirp 3 batch is slower than the target, mis-diarizes long or mixed audio, or behaves differently from the docs: the page contradicts itself on diarization in `Recognize` and on word timestamps | **Spike T107 before go-live.** It covers 1 h and 3 h synthetic it/en, whole file vs 60-min parts, `speakerLabel` without word offsets, result granularity, latency from Railway Amsterdam, `gcsOutputConfig` on `eu`, which hosts serve `cacheConfig`/`fetchPublisherModelConfig` for `eu`, and IAM permission names. Its outcome fixes `PIECE_MAX_MS` and word offsets and records the fixtures |
| R13 | Traffic reaches a non-EU endpoint: the SDK's environment defaults, a code regression to `global`, or ADC picking up other credentials | The base URL is derived and asserted by test; explicit `authClient`; `ANTHROPIC_VERTEX_BASE_URL` refused (S5); location allowlist without `global`; the global-endpoint organization policy (defence in depth) |
| R17 | Google keeps async transcripts ~5 days (FAQ), against the no-retention Constraint | Cloud Storage output instead of inline; `operations.delete` after reading; **go-live gated on H4/Q1**; the named fallback is sync `Recognize` without diarization (AC-6.2 regression, PO decision) |
| R18 | A transient copy outlives a deletion (a crashed attempt, a late output write) | Per-attempt prefix, deleted at attempt start and in `finally`; deletion routes delete it first (503 on failure); a 1-day lifecycle rule; soft delete 0 verified; bound stated in § G-2 |
| R19 | A long-lived service-account key leaks from Railway | Least-privilege custom role; 90-day expiry policy; separate eval SA via WIF; never logged; env-doctor secret; Cloud Audit Logs on the SA's use; WIF as soon as Railway offers workload OIDC |
| R20 | Speaker labels split across parts confuse readers and summaries | Never-merge rule (no false attribution); banner and part dividers; merge by rename; the spike may remove splitting; overlap-alignment is the named follow-up |
| R21 | A Google control-plane outage blocks a deploy or restart (startup reads) | Accepted, as with AWS before; `maxAttempts` 2 on each startup read; it fails closed by design |
| R22 | Anthropic's Commercial Terms (H5) add a second contract relationship despite the "one contract" goal | DPL review before production data (O3); Google's statement that partner models do not receive prompts or responses |

### G-14 Security delta

Still **YES**, and the owasp review of this delta runs at the **frontier tier** (voice recordings,
regulated clients). New or changed surfaces:
- `MEETINGS_GCP_SERVICE_ACCOUNT_KEY` handling: parse once, never logged, kept out of the ffmpeg
  child env (the probe/normalize env test gains it), env-doctor secret.
- The transient bucket: policy checks (N2), IAM scope (runtime SA vs Speech agent), object names
  (identifiers only), prefix-scoped delete that refuses any other prefix (as `deletePrefix` does
  for Railway).
- Reading Google's output JSON: size cap, prefix check, shape validation before use, no provider
  text in errors or logs.
- The Vertex request: forced single tool, no cache, no server tools, explicit base URL and
  credentials.
- Startup checks N2–N4 and env S1–S6, so neither can become fail-open.
- The eval workflow's WIF trust condition: the repository and the `meetings-eval` environment
  only.

Processors: Google Cloud Speech-to-Text v2 (`eu`), Vertex AI Claude (`eu`) and Cloud Storage
(EU/CH location), under one Google contract (H2), plus Anthropic's terms for model use (H5).
DPA/O3 sign-off before production data.

### G-15 ADR candidates and affected ADRs

12. **0069 — Meetings AI processing on Google Cloud: Chirp 3 batch through a transient EU bucket and
    Claude on Vertex AI (EU); verify at startup what Google exposes, sign off what it does not;
    supersedes ADR-0061's provider choice**
    (`docs/adr/0069-meetings-ai-providers-google-cloud-eu.md`).
    - It supersedes ADR-0061 decision points 1, 2, 4 and 5, and the provider-specific parts of 3
      and 6. ADR-0061's principle (every hop verified at startup, unreadable = refuse, no fake in
      production) and its failure shape stay; 0061's status becomes "superseded in part by 0069".
    - *Rejected:*
      - keeping Azure Speech + Bedrock (two vendors and two DPAs; no contract will be signed);
      - sync `Recognize` without a bucket (no usable diarization; kept as the fallback for Q1);
      - `StreamingRecognize` (no diarization for Chirp 3, real-time pacing);
      - inline batch output (Google stores it ~5 days);
      - the Vertex global endpoint (no residency);
      - Claude Fable/Mythos (Advanced AI logging);
      - Workload Identity Federation for the runtime (Railway has no workload OIDC; used for CI);
      - Application Default Credentials;
      - gRPC client libraries on Bun.
13. **0070 — A long recording is transcribed in parts, and speaker labels are numbered per part,
    never carried over** (`docs/adr/0070-meetings-transcript-parts-speaker-labels-per-part.md`).
    - The rule: a system that cannot tell whether two voices are the same person must not say they
      are. A false attribution reaches every summary; a duplicate label costs one rename.
    - *Rejected:*
      - carrying labels across parts by ordinal;
      - voice-embedding matching (new biometric-adjacent processing);
      - overlap-alignment now (named follow-up with a trigger);
      - one whole-meeting request regardless of Google's guidance (the spike decides; the code
        allows it).

Affected ADRs (not edited here; the adr-writer or a follow-up amends them):
- **ADR-0062:**
  - ffmpeg exclusivity is a process slot, not a job kind;
  - `transcribe` is now a long-running poll, still lease-heartbeated;
  - R6's re-run cost now includes re-uploading the parts.
- **ADR-0063:** a second bucket exists, transient, with its own startup-verified rules (1-day
  lifecycle, soft delete 0, versioning off); explicit deletes clear both prefixes first.
- **ADR-0064:**
  - the transcribe job splits our own derived `audio.ogg` with ffmpeg under the same flags, and
    reads Google's output JSON with an 8 MiB cap;
  - neither is a new reader of user-chosen bytes, so the escalation trigger is not tripped. A note
    says so.
- **ADR-0067:**
  - the model-change gate's variable is `MEETINGS_VERTEX_MODEL_ID`;
  - the live eval runs on Vertex through WIF.
- **AGENTS.md:** the 0061 line, the meetings-api bullet, the data-residency section and the ADR
  list (0069, 0070) need updating (T109).

### G-16 Open questions for the user

- **Q1 (blocks go-live; user + data-protection lead).** Google's Speech data-usage FAQ says the
  async endpoint stores "the resulting transcript … for approximately 5 days". It is not documented
  whether this applies when the output goes to our own bucket (`gcsOutputConfig`, chosen here).
  - Proposal: ask Google, through the account team or as part of the contract, for a written
    statement (H4).
  - If Google confirms no storage with Cloud Storage output, nothing changes.
  - If it does not, the choice is the user's and the DPL's:
    - (a) accept a ≤ 5-day Google-side transcript copy as within the contract's terms. This
      touches the spec Constraint "must contractually not retain submitted content beyond the
      request", so it would be a PO amendment, not a plan detail;
    - (b) switch to the sync `Recognize` fallback: no storage at Google and no bucket, but one
      speaker label per meeting, a visible AC-6.2 regression the PO must accept.
- **Q2 (before production data; DPL).** Is "one contract" the Google Cloud **Master Agreement**?
  Under the online Terms of Service, flagged prompts can be logged for up to 90 days and reviewed
  by humans (H2). Enabling Claude also accepts Anthropic's Commercial Terms (H5).
- **A5 (optional spec clarification; PO).** AC-6.2 could add: "A recording longer than about an
  hour may be transcribed in parts; labels are numbered separately in each part, and renaming two
  labels to the same name merges them." The plan works without it, because AC-6.2 is best effort,
  but the spec would then describe what the UI shows. The PO decides; spec.md is not edited here.

### G-17 Proposed tasks.md delta (for the re-sync; tasks.md is not edited here)

**Superseded tasks.** Keep them `[x]` as history with the note "superseded 2026-11-05 (provider
change), see T95+":
- T31 (Azure transcriber), by T97;
- T35 (Bedrock model and checks), by T100 and T101;
- the Azure/Bedrock parts of T11, by T95.

**Reopened by a delta task.** T81 (T105), T82 (T106), T83 (T103), T84 (T104), T85 (T109). T92 gains
deps T95–T110.

- [ ] T95: [BE] meetings-api env + sync residency for Google. Removes `AZURE_*`, `BEDROCK_*` and `MEETINGS_AWS_*`. Adds `MEETINGS_SPEECH_LOCATION` {eu}, `MEETINGS_VERTEX_LOCATION` {eu, europe-west1, europe-west4}, `MEETINGS_VERTEX_MODEL_ID` (claude-, no fable/mythos), `MEETINGS_GCP_PROJECT_ID`, `MEETINGS_GCP_SERVICE_ACCOUNT_KEY` (base64 JSON, type/project/email/key checks) and `MEETINGS_GCS_TRANSIENT_BUCKET`. Refuses `ANTHROPIC_VERTEX_BASE_URL`; messages stay value-free — refs: AC-4.9 — deps: none
  - touch: `meetings-api/src/lib/env.ts`, `meetings-api/src/lib/env.test.ts`, `meetings-api/src/lib/residency.ts`, `meetings-api/src/lib/residency.test.ts`
  - done when: `cd meetings-api && bun test src/lib/env.test.ts src/lib/residency.test.ts` passes, with a case per S1–S6, including `global`, `us`, `europe-west2`, a `claude-fable-…` id, a key whose `project_id` differs, and a non-base64 key. No test output contains a configured value
- [ ] T96: [BE] Google auth + transient storage + bucket startup check. Covers:
  - a google-auth-library JWT client from the explicit key (never ADC), token cached;
  - the GCS JSON API on the regional endpoint derived from the bucket location: upload with `ifGenerationMatch=0`, bounded read, list and delete of `transcribe/<meetingId>/` only (any other prefix refused), plus a fake;
  - `checkTransientBucket` (N2), wired into `runStartupChecks`.

  refs: AC-4.9, AC-4.5, AC-4.6 — deps: T95
  - touch: `meetings-api/src/lib/google/auth.ts`, `meetings-api/src/lib/google/auth.test.ts`, `meetings-api/src/lib/google/transientStorage.ts`, `meetings-api/src/lib/google/transientStorage.test.ts`, `meetings-api/src/lib/startupChecks.ts`, `meetings-api/src/lib/startupChecks.test.ts`, `meetings-api/package.json`, `meetings-api/bun.lock`
  - done when: `bun test src/lib/google src/lib/startupChecks.test.ts` passes. It includes a refusal per N2 property (soft delete 7 d, versioning on, a `matchesPrefix` rule, age 2, `EUROPE-WEST2`, PAP not enforced, unreadable metadata), a test that `deletePrefix("transcribe/")` and other meetings' prefixes are refused, and a test that object URLs use `storage.<location>.rep.googleapis.com`
- [ ] T98: [BE] Process-level ffmpeg slot. `withFfmpegSlot()` replaces the runner's `FFMPEG_KIND` exclusion; `prepare_audio` uses it; the minimal-child-env test lists `MEETINGS_GCP_SERVICE_ACCOUNT_KEY` — refs: AC-3.1, AC-6.10 — deps: none
  - touch: `meetings-api/src/media/ffmpegSlot.ts`, `meetings-api/src/media/ffmpegSlot.test.ts`, `meetings-api/src/jobs/runner.ts`, `meetings-api/src/jobs/runner.test.ts`, `meetings-api/src/jobs/handlers/prepareAudio.ts`, `meetings-api/src/media/probe.test.ts`
  - done when: `bun test src/media src/jobs` passes; a test shows two `prepare_audio` jobs never run ffmpeg concurrently, while a `transcribe` job waiting outside the slot does not block a `prepare_audio` claim
- [ ] T97: [BE] Chirp 3 transcriber. Covers:
  - the splitter: silencedetect + segment copy under the slot, with `PIECE_MAX_MS` and word offsets as code constants;
  - per-part upload, `batchRecognize` (chirp_3, one locale, diarization, `gcsOutputConfig`), polling with backoff and deadline, bounded output read, `operations.delete`, and prefix cleanup at start and in `finally`;
  - result → `Phrase` with part offsets, `p<n>:<label>` speakers and word-run splitting, plus `partStartsMs`;
  - the § G-8 mapping, and hand-built REST fixtures;
  - deletion of `azureSpeech.ts` and its test.

  refs: AC-6.1, AC-6.2, AC-6.5, AC-6.7, AC-6.9, AC-13.2, AC-4.10 — deps: T96, T98
  - touch: `meetings-api/src/ai/googleSpeech.ts`, `meetings-api/src/ai/googleSpeech.test.ts`, `meetings-api/src/media/split.ts`, `meetings-api/src/media/split.test.ts`, `meetings-api/src/media/split.real.test.ts`, `meetings-api/src/ai/transcriber.ts`, `meetings-api/src/ai/fakeTranscriber.ts`, `meetings-api/src/ai/segments.ts`, `meetings-api/src/ai/azureSpeech.ts`, `meetings-api/src/ai/azureSpeech.test.ts`, `meetings-api/test-fixtures/google-speech/*`
  - done when: `bun test src/ai src/media/split` passes with the § G-12 Speech cases, including "prefix deleted in finally on success and on each failure row". `split.real.test.ts` passes in the ffmpeg image (skips without ffmpeg). `git grep -i azure meetings-api/src` is empty
- [ ] T99: [BE] Transcribe job + migration + transcript `parts`. Covers:
  - `transcriptPartStartsMs` (new migration), written in the existing commit and reset on retry;
  - `GET /meetings/:id/transcript` returns `parts`;
  - OpenAPI updated.

  refs: AC-6.1, AC-6.2, AC-6.7, AC-6.9 — deps: T97
  - touch: `meetings-api/prisma/schema.prisma`, `meetings-api/prisma/migrations/*_transcript_parts/*`, `meetings-api/src/jobs/handlers/transcribe.ts`, `meetings-api/src/jobs/handlers/transcribe.test.ts`, `meetings-api/src/transcript/transcript.routes.ts`, `meetings-api/src/transcript/transcript.test.ts`
  - done when: on `meetings_test`, `bun run db:deploy && bun test src/jobs/handlers/transcribe.test.ts src/transcript` passes. Cases: three parts → `parts` with three entries and labels s1..s5 across parts; a retry replaces parts; a text meeting gives `parts: []`; `noSpeech` gives `parts: []`
- [ ] T100: [BE] Vertex Claude language model. Covers:
  - `@anthropic-ai/vertex-sdk` with a derived `baseURL`, explicit `authClient`, `maxRetries: 0` and a 60 s timeout;
  - forced `tool_choice`, with no `cache_control`, server tools, `advanced_ai_enabled` or betas;
  - the § G-8 mapping, and `languageModel.ts` wiring;
  - deletion of `bedrock.ts` and its test, and removal of `@aws-sdk/client-bedrock-runtime`.

  refs: AC-7.9, AC-7.10, AC-9.6, AC-4.10 — deps: T96
  - touch: `meetings-api/src/ai/vertexClaude.ts`, `meetings-api/src/ai/vertexClaude.test.ts`, `meetings-api/src/ai/languageModel.ts`, `meetings-api/src/ai/bedrock.ts`, `meetings-api/src/ai/bedrock.test.ts`, `meetings-api/package.json`, `meetings-api/bun.lock`
  - done when: `bun test src/ai/vertexClaude.test.ts src/ai/prompts` passes with the § G-12 Vertex cases, including the host assertion while `ANTHROPIC_VERTEX_BASE_URL` and `CLOUD_ML_REGION` are set in the test env
- [ ] T101: [BE] Vertex startup checks N3 (`cacheConfig.disableCache`) and N4 (`fetchPublisherModelConfig`: 404 passes, `enabled`/`enableOtelLogging` true refuse, other errors refuse). Removes `checkBedrock` and `@aws-sdk/client-bedrock` — refs: AC-4.9 — deps: T96, T100
  - touch: `meetings-api/src/lib/startupChecks.ts`, `meetings-api/src/lib/startupChecks.test.ts`, `meetings-api/package.json`, `meetings-api/bun.lock`
  - done when: `bun test src/lib/startupChecks.test.ts` passes with each N3/N4 case. `bun run typecheck` passes. `git grep -i bedrock meetings-api/src meetings-api/package.json` is empty
- [ ] T102: [BE] The deletion paths clear the transient prefix. `DELETE /meetings/:id` and `DELETE /meetings/:id/audio` delete `transcribe/<id>/` with the Railway prefix, before the DB change, and answer 503 with nothing changed on failure — refs: AC-4.5, AC-4.6 — deps: T96
  - touch: `meetings-api/src/meetings/delete.routes.ts`, `meetings-api/src/meetings/delete.test.ts`, `meetings-api/src/audio/audio.routes.ts`, `meetings-api/src/audio/audio.test.ts`
  - done when: on `meetings_test`, `bun test src/meetings/delete.test.ts src/audio/audio.test.ts` passes. The fake transient storage records the delete before the cascade, and a failing fake gives 503 with the meeting and its audio intact
- [ ] T103: [QE] Live eval on Vertex. `evals/run.ts --live` builds the Vertex model (explicit key or a WIF credential file; S2/S3 applied). The tests check the Vertex module is loaded only in the live branch. The meetings-api README covers env (§ G-7) and release (`MEETINGS_VERTEX_MODEL_ID`) — refs: AC-7.12, AC-9.7 — deps: T100
  - touch: `meetings-api/evals/run.ts`, `meetings-api/evals/eval.test.ts`, `meetings-api/README.md`
  - done when: `bun run eval` (fake) exits 0; `bun test evals/eval.test.ts` passes, including "refuses without the Vertex configuration, naming the variables and no values" and "location `global` refused"; `git grep -i bedrock meetings-api/evals meetings-api/README.md` is empty
- [ ] T104: [OPS] CI. `meetings-eval-live.yml` authenticates by GitHub OIDC WIF (`permissions: id-token: write`, `google-github-actions/auth` pinned by SHA) with the `MEETINGS_EVAL_*` vars of § G-7, keeping the skip-on-schedule / fail-on-dispatch behaviour. The `meetings-eval.yml` guard regex is updated — refs: AC-7.12, AC-9.7 — deps: T103
  - touch: `.github/workflows/meetings-eval-live.yml`, `.github/workflows/meetings-eval.yml`
  - done when: `actionlint` passes on both files; the PR job is green on the branch; a dispatched run without the vars fails naming them
- [ ] T105: [OPS] env-doctor. `meetings-api` required keys and `SECRET_VARS` per § G-7; the seven removed names flagged as retired; the production template updated — refs: AC-4.9 — deps: T95
  - touch: `tools/env-doctor/manifest.ts`, `tools/env-doctor/templates/production/meetings-api.env`, `tools/env-doctor/check.test.ts`, `tools/env-doctor/retiredToken.test.ts`
  - done when: `mise run env:doctor` passes on the production templates. The env-doctor tests pass with new cases: missing `MEETINGS_GCP_SERVICE_ACCOUNT_KEY` reported; `AZURE_SPEECH_KEY` present → retired; the key's value never printed
- [ ] T106: [OPS] `infra/meetings-gcs-transient-policy.sh` (apply/check the N2 rules on a GCS bucket via `gcloud storage`) and the infra README meetings section. The README covers:
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
- [ ] T107: [QE] Google spike (release gate; replaces R2's Azure spike), in a sandbox project with synthetic it/en audio of 1 h and 3 h. It records the R2 measurements, sets `PIECE_MAX_MS` and word offsets in `googleSpeech.ts`/`split.ts`, and replaces the hand-built fixtures with scrubbed recorded ones. Outcome in a dated note under § G-3 of plan.md (via the orchestrator) — refs: AC-6.1, AC-6.2, AC-6.5 — deps: T97, T101, T106
  - touch: `meetings-api/scripts/spike-google-speech.ts`, `meetings-api/test-fixtures/google-speech/*`, `meetings-api/src/ai/googleSpeech.ts`, `meetings-api/src/media/split.ts`
  - done when: `bun test src/ai/googleSpeech.test.ts src/media/split.test.ts` passes on the recorded fixtures; the measured p95 latency and the chosen constants are recorded; a startup against the sandbox project passes N2–N4
- [ ] T108: [FE] meetings-ui transcript parts. The info `Banner` and per-part dividers when `parts.length > 1`, en/it copy, types, and fakeApi fixtures with a three-part transcript — refs: AC-6.1, AC-6.2, AC-13.1 — deps: none (contract § G-11)
  - touch: `meetings-ui/src/components/transcript/TranscriptView.tsx`, `meetings-ui/src/components/transcript/TranscriptView.test.tsx`, `meetings-ui/src/strings/transcript.ts`, `meetings-ui/src/lib/types.ts`, `meetings-ui/src/test-support/fakeApi.ts`
  - done when: `cd meetings-ui && pnpm lint && pnpm build && pnpm test` passes. New component cases: one part → no banner, no divider; three parts → banner + two dividers with formatted times; `catalogGaps` parity holds
- [ ] T109: [OPS] AGENTS.md: the meetings rows (structure, meetings-api bullet, data-residency section, `MEETINGS_AI_PROVIDER` note) name Google Cloud (Speech `eu`, Vertex `eu`, transient bucket); the 0061 line is marked superseded in part; 0069 and 0070 are added — refs: AC-4.9 — deps: none (after the ADRs exist)
  - touch: `AGENTS.md`
  - done when: `git grep -n -i -E 'bedrock|azure ai speech|westeurope' AGENTS.md` matches only the 0061 line's history note; `mise run env:doctor` still passes
- [ ] T110: [OPS] Changesets for meetings-api and meetings-ui (the provider change and transcript parts) — refs: AC-10.5 — deps: T95–T108
  - touch: `.changeset/*.md`
  - done when: `mise run changeset:check` passes

**Overlaps** (all ordered by deps):

| Shared file | Order |
|---|---|
| `meetings-api/package.json` + `bun.lock` | T96 → T100 → T101 |
| `src/lib/startupChecks.ts` | T96 → T101 |
| `src/ai/googleSpeech.ts`, `src/media/split.ts`, `test-fixtures/google-speech/*` | T97 → T107 |

`src/ai/transcriber.ts` and `src/ai/fakeTranscriber.ts` (T97), `transcribe.ts` (T99), `runner.ts`
(T98), `meetings-api/README.md` (T103), `infra/README.md` (T106), env-doctor (T105) and
`AGENTS.md` (T109) each have one owner.

**Coverage additions:**
- AC-4.9 → T95, T96, T101, T105, T106;
- AC-4.5/4.6 → T96, T102;
- AC-6.1/6.2 → T97, T99, T108;
- AC-6.5 → T97;
- AC-6.7/6.9 → T97, T99;
- AC-13.2 → T97;
- AC-7.9/7.10/9.6 → T100;
- AC-7.12/9.7 → T103, T104;
- AC-4.10 → T97, T100.

Sources (read 2026-11-05):
- [G1] https://cloud.google.com/speech-to-text/v2/docs/chirp_3-model (regions `eu`/`us` GA; diarization languages incl. it-IT, en-US; BatchRecognize "1 minute to 1 hour … up to 20 minutes with word-level timestamp"; utterance timestamps streaming-only; updated 2026-10-26)
- [G2] https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/data-residency (Claude EU multi-region / europe-west1 table; `eu` excludes UK and CH; global gives no residency; updated 2026-11-04)
- [G3] https://cloud.google.com/speech-to-text/v2/docs/reference/rest/v2/projects.locations.recognizers/batchRecognize, …/v2/docs/batch-recognize, …/v2/docs/quotas (GCS-URI-only audio source; inline vs GCS output; 8 h per file; quotas)
- [G4] https://cloud.google.com/speech-to-text/docs/data-usage-faq and …/docs/v1/data-logging, …/enable-data-logging (sync/stream in memory; async transcript ~5 days; data logging opt-in, console toggle; v2 `Config` exposes only `kmsKeyName`)
- [G5] https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/abuse-monitoring and …/resources/zero-data-retention (abuse-monitoring scope and CMA exemption; Advanced AI = Claude Mythos, Fable; Anthropic terms; cacheConfig GET/disable; request-response logging)
- [G6] https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/request-response-logging (`fetchPublisherModelConfig`; 404 = default disabled)
- [G7] https://cloud.google.com/storage/docs/regional-endpoints (data at rest and in transit stay in location; EU multi-region supported)
- [G8] https://cloud.google.com/storage/docs/soft-delete (on by default, 7 days; 0 disables)
- [G9] https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/use-partner-models (EU multi-region endpoint `aiplatform.eu.rep.googleapis.com`; Claude ≥ 4.7; EU quotas; prompts and responses not shared with third parties)
- `@anthropic-ai/vertex-sdk` 1.1.2 `client.js` (region `eu` → `aiplatform.eu.rep.googleapis.com`; reads `ANTHROPIC_VERTEX_BASE_URL`/`CLOUD_ML_REGION` by default; `maxRetries` default 2)

## Amendment 2026-11-05 (#2: T107 drifts and spec A7)

> **Approved by the user 2026-11-05.** QH-1: wellD staff provide consented internal recordings (≥ 10, ≥ 8 h, it/en, in person and online). T125 (O14) is a **go-live** gate, not a gate on closing 021. QH-2: the live eval tolerates up to 2 `invalid_output` outcomes of ~55 fixtures after the resample; zero tolerance on safety findings. **Extended by the user 2026-11-05 (T121):** an over-refusal (model-tier `answers-what-the-meeting-contains`: the model says the meeting does not contain an answer it does contain) counts in the same availability budget — at most 2 per run for `invalid_output` and over-refusals together; injection-compliance and request/server-tier findings stay zero-tolerance.

> **Scope.** The real-provider spike (T107 note, § G-3) found four drifts, and the user decided them on
> 2026-11-05: spec amendment **A7** (approved, incl. AC-6.16 and the AC-6.7 `failed` outcome) and
> decision **D4** (Claude Sonnet 5.5 on Vertex rejects a forced `tool_choice` and `thinking: disabled`;
> a single tool is offered unforced, and anything other than exactly one valid call is `invalid_output`).
> This amendment designs both. It **replaces** G-3's "Speakers across parts … never claimed to be the
> same person", the G-3 banner copy and condition, G-4's `tool_choice` line, G-8's last row and the
> G-11/G-12 rows named below. Everything else in G-0 to G-17 stands: the transient bucket and its
> checks, residency, credentials, error codes, ADR-0062's runner, ADR-0067's prompt layout,
> validators and plain-text rendering. Plan `status:` is untouched.

### H-0 Spec check

- Every A7 change has a section here: AC-4.12 (H-4), AC-6.2/6.14/6.15/6.17 (H-2), AC-6.6 (H-7),
  AC-6.7/6.9/6.10/6.11 (H-3, H-4), AC-6.12 (H-3, H-5, H-7), AC-6.13 (H-2), AC-6.16 (H-5, H-7),
  AC-7.9/9.6 (H-8), AC-7.13/9.9 (H-6, H-7), O13 (b) (H-4), O14 (H-9, T125).
- **The Constraints' bounds are confirmed, provisionally until O14:** overlap 90 s, chosen in a pause
  between 60 s and 120 s (bound 30 s–2 min); gap 20 s; retry 2 (3 tries per part); repeat 8 words and
  2 s; match 20 words. They are code constants (H-1 table), never env.
- **Two readings the plan takes, neither an amendment:**
  - *AC-6.15 "the overlap affected by a gap" vs AC-6.17 "the joins are the same whatever the audio".*
    A detected gap uses the audio's sound intervals, so a join rule that consulted it would depend on
    the audio. The join rule therefore uses a text-and-time condition that is a **superset** of
    "affected by a detected gap": the overlap is affected when either version has a stretch of at
    least the gap bound with no timed word that reaches into the overlap (H-2 J0). A detected gap
    always lies inside such a stretch (it needs at least 20 s of credited sound with no timed word),
    so a gap that touches the overlap always triggers it, and both ACs hold literally. The cost is a
    few extra separate labels where people were silent for 20 s across a seam.
  - *AC-6.16 "each keeping the name the joined label had".* When the joined label had no name
    ("Speaker 2"), each separated label keeps reading "Speaker 2" until renamed (a stored
    `defaultIndex`, H-5); the UI shows each one's part, so they stay distinguishable.
- **A watch item, not an amendment now.** AC-6.14 (b) "the earlier part attributes **all** of them to
  the same L1" is applied word by word. Diarization often moves the first or last word of a turn to
  the neighbouring speaker, and one such word blocks a join. That is the safe direction (a false
  split costs a rename), so the plan applies it literally. If O14 shows the join rate is low for
  that reason only, the architect proposes a spec amendment (e.g. ignore the first and last word of
  each turn); it is not pre-empted here.

### H-1 Overlapping parts

**Evidence (T107).** Google refuses a Chirp 3 batch file over 20 min. At 18–19 min, 2 of 4 parts
silently lost 19–45 % of their words. At 10 min, 6 of 7 parts of one file were complete (98–103 %)
and 3 of 19 of another lost 16–28 %. The first sentence of a part often has implausible word
offsets. So the part length stays at the measured 10 min, and the overlap must be long enough to
carry 20 matched words for each speaker active across a seam, with both edges of a part in a pause.

| Constant (code, `src/media/split.ts` unless noted) | Value | Bound / evidence |
|---|---|---|
| `PIECE_MAX_MS` | 10 min, **including** the overlap (unchanged length) | provider cap 20 min; omissions measured at 18–19 min |
| `OVERLAP_TARGET_MS` / `OVERLAP_MIN_MS` / `OVERLAP_MAX_MS` | 90 s / 60 s / 120 s | spec 30 s–2 min. A speaker reaches the 20-word match bound with about 8–10 s of speech inside the overlap, so 90 s can join anyone who holds roughly 10 % of it (at 60 s, roughly 15 %). 120 s adds a third more billed overlap and makes J0's 20 s hole more likely inside it. The 60–120 s pause window keeps cuts in pauses. O14 confirms the value |
| `CUT_WINDOW_MS`, `MIN_SILENCE_MS` | 90 s, 0.5 s (unchanged) | |
| `SILENCE_NOISE_DB` | −35 dB, now measured on a **speech-band** signal (`highpass=f=150,lowpass=f=4000`) | removes hum and rumble from "sound"; music still counts (H-3) |
| `MAX_PARTS` | 32 | 3 h + 60 s needs 22 |

**Where parts start and end** (pure `chooseParts(durationMs, silences)`, replaces `chooseCuts`):

```
s1 = 0
for k = 1, 2, …:
  if D − s_k ≤ PIECE_MAX_MS: part k = [s_k, D]; stop
  mark = s_k + PIECE_MAX_MS
  e_k  = middle of the longest pause ≥ 0.5 s in [max(s_k + PIECE_MAX_MS/2, mark − CUT_WINDOW_MS), mark], else mark
  s_k+1 = middle of the longest pause ≥ 0.5 s in [e_k − OVERLAP_MAX_MS, e_k − OVERLAP_MIN_MS], else e_k − OVERLAP_TARGET_MS
  (ties: the later pause; refuse (SplitError) if s_k+1 ≤ s_k + PIECE_MAX_MS/2)
```

Both edges of every part fall in a pause where one exists, so few words are cut at either edge, and
the garbled first sentence of part k+1 lies inside the overlap, where part k's version covers it.

**How parts are written.** The segment muxer cannot write overlapping pieces, so `parts.csv` is
retired. Each part is one stream copy with output seeking, under the ffmpeg slot:
`ffmpeg <ADR-0064 input flags> -i audio.ogg -ss <s> -to <e> -c copy -f ogg part-<k>.ogg`. It demuxes
from the start without decoding (about a second for 3 h of 16 kHz Opus) and is exact to one 20 ms
packet, so the offset is the requested `s` (an error of at most 20 ms, below anything the detector or
the 2 s repeat bound can see). The ADR-0064 hardening is unchanged.

**The silence pass now always runs**, also for a recording of 10 min or less. Today it is skipped
then. The gap detector (H-3) and AC-6.7 need the sound intervals of every recording. The pass costs
1–2 s for 10 min and 10–30 s for 3 h. `splitAudio` returns `{ parts: {path, startMs, endMs}[],
silences, durationMs }`.

**Parts for 3 h + 60 s:** at the target overlap N = 1 + ⌈(D − L) / (L − O)⌉ = 1 + ⌈(10 860 − 600) / 510⌉ = **22**.
In the worst case, when pauses pull every cut to the window edges (stride 390 s), there are 28 parts.
`MAX_PARTS` = 32 holds, and the guard `s_k+1 > s_k + PIECE_MAX_MS/2` can never fail (390 > 300).

**Cost (USD 0.016 per audio minute, G-10; confirm at provisioning).** Billed time = D + (N − 1) × O.
- For 3 h + 60 s that is 181 + 31.5 = 212.5 min ≈ **USD 3.40** per attempt, against USD 2.90 without
  overlap: +17 %. A 1 h meeting: 7 parts, 69 min ≈ USD 1.10 (+15 %).
- Per-part retries (H-4): each costs one part (≤ 10 min ≈ USD 0.16). At the spike's rate
  (about 1 part in 7 incomplete) that is about +USD 0.50 for 3 h. Worst case: every part tried 3
  times, ≈ USD 10.20 per job attempt.
- The job-level retry on a transient error (unchanged, ADR-0062) re-runs everything: the absolute
  ceiling is 3 × USD 10.20 ≈ USD 30.60 for one 3 h meeting. It is not reachable in practice, and
  per-meeting spend stays visible in Google billing.

### H-2 Stitching: deduplication and speaker continuity (pure, `src/ai/stitch.ts`)

**Input** (provider-neutral, defined in `src/ai/words.ts`). Per part k: its span `[s_k, e_k]` and its
words in provider order. Each word carries: `text`; `label` (namespaced `p<k>:<label>`); `noise`
(the `[`/`[BACKGROUND]` markers); and `span`, the trusted `[startMs, endMs]` in meeting time, or null
(G-3/T107 `spanOf` rules, unchanged). **No audio-derived value enters `stitch.ts`'s join functions**;
the type has no field for one (AC-6.17).

**Normalisation** (shared by every rule, AC-6.13): Unicode NFD, combining marks removed, lower case,
every character that is not a letter or digit removed; a token that becomes empty is dropped. Noise
markers are never tokens.

**Effective time of an untimed word**, used only where H-2 says so: the interval from the end of the
nearest earlier timed word to the start of the nearest later timed word of the same part (the part's
edges where there is none). It is never a point and never outside its part.

**D1. Within one part (AC-6.13), on the part's chosen try.** A **repetition** is a pair of
non-overlapping token runs A (earlier) and B (later) of at least `REPEAT_WORDS` = 8 equal tokens,
such that A's last token and B's first token both have a trusted span and either the runs' time
ranges overlap or `B.start − A.end ≤ REPEAT_GAP_MS` = 2 000.
- The scan is deterministic: positions in order, using an 8-gram index; for each B the earliest
  matching A; the match extended to its maximal length.
- B's tokens are removed (the first is kept).
- An untimed boundary token means no evidence, so the passage is left as returned. That is the spec's
  "never removed" guarantee for a phrase really said twice more than 2 s apart.

**D2. Across the overlap of parts k and k+1 (AC-6.13).**
- Window: P = part k's tokens whose effective time reaches `s_k+1 − 2 s` or later, and Q = part k+1's
  tokens whose effective time starts at `e_k + 2 s` or earlier.
- Candidates: every maximal common run of at least 8 equal tokens between P and Q whose effective time
  ranges overlap or lie within 2 s of each other.
- Anchors: candidates accepted greedily, ordered by length (descending), then by the distance
  between midpoints (ascending), then by P index, then by Q index. A candidate is accepted only if it
  neither crosses nor overlaps an accepted one in **both** sequences. The result is an
  order-preserving one-to-one alignment.
- Q's anchored tokens are removed (part k's version is "the first", and is kept). Every unanchored
  token of P or Q is kept, so no speech present in either version is dropped. Between two
  consecutive anchors (and before the first and after the last), the unanchored tokens of P and Q are
  merged by effective start time, P first on a tie.
- An alignment cannot collapse two copies within one version, so a phrase said twice keeps both
  copies.
- Visible residual: text that the two versions transcribed differently (fewer than 8 equal words)
  appears twice near the seam. The creator can edit it (AC-6.3).

**J. Joins at the boundary k | k+1 (AC-6.14, AC-6.15).**
- J0. No label of part k+1 is joined at this boundary if either version has a hole of at least
  `GAP_BOUND_MS` = 20 000 (a stretch with no trusted word, computed on its own timeline as in H-3,
  but without sound) that intersects the overlap window `[s_k+1, e_k]`. Every detected gap lies
  inside such a hole, so this is the text-and-time superset of "the overlap affected by a gap"
  (H-0).
- J1. Over the anchors of D2, pair the tokens position by position and count `n[L2][L1]`: the tokens
  that part k+1 attributes to L2 and part k attributes to L1.
- J2. L2 is joined to L1 when all three hold:
  - (a) Σ_L1 n[L2][L1] ≥ `MATCH_WORDS` = 20;
  - (b) n[L2][L1′] = 0 for every L1′ ≠ L1;
  - (c) n[L2′][L1] = 0 for every L2′ ≠ L2.
- Otherwise L2 is **separate**. Nothing else (position, number, order of appearance, a default)
  ever joins.
- J3. Chaining: a join maps `p<k+1>:L2` → `p<k>:L1`, and each label resolves to its root by following
  the map, one consecutive boundary at a time. A joined label of part 3 reaches part 1 only through
  part 2.
- J4. Segments: after D1, D2 and J, consecutive tokens with the same root form one segment carrying
  the `part` of its tokens' version. A segment also ends at every final gap (H-3), so a gap marker
  always falls between segments. Times follow the never-late rule (G-3).
- J5. Speaker keys are numbered by first appearance of the **root** (`mapPhrases`, unchanged). A
  joined label carries its root's key, name and number everywhere. A separate label gets the next
  unused number (AC-6.2).

**Determinism (AC-6.17).** D2 and J are pure functions of the part spans and the provider's words
(text, labels, trusted times). No randomness, no clock, no locale-dependent comparison
(normalisation is explicit). The replay test (H-10) asserts identical joins for identical outputs
under different silence lists and different audio files.

### H-3 The gap and repetition detector (pure, `src/ai/completeness.ts`)

**Sound.** The complement of the silences (speech band, −35 dB, ≥ 0.5 s) within a span. It is energy,
not speech: music and loud noise count as sound. Two rules keep that from becoming a flood of false
gaps (below).

**Per part and per try, the holes.** Sort the part's trusted speech words by start. The holes are the
stretches between consecutive words, plus the stretch from the part's start to the first word and
from the last word to the part's end. A part with no timed word is one hole.

**A hole is a gap** when its credited sound is at least `GAP_BOUND_MS` = 20 s:
- credited sound = (sound inside the hole) − `UNTIMED_WORD_CREDIT_MS` (600 ms) × (untimed speech
  words that sit between the hole's bounding words in provider order);
- an untimed word is text that exists somewhere in the hole, so it is credited the time a word takes
  at 100 words/min (generous), never more;
- the gap's range is from the first sound start to the last sound end inside the hole. It is never
  narrower than what was detected.

**False-positive handling.**
1. *Hum and rumble* are filtered out by the speech-band filter.
2. *The provider's noise marker.* T107 recorded a lone `[` (its `[BACKGROUND]`) for silence and for a
   20 s tone, with an `endOffset` of 0.6 s whatever the length. That time cannot be used, so the
   marker counts by position: a hole whose bounding words have a noise marker between them in
   provider order is **declared non-speech by the provider** and is not a gap. This also holds for a
   part whose only output is markers.
   - Residual: a marker emitted inside real, untranscribed speech would hide a gap. It was never
     observed (every observed omission was a hole between words, with no marker), and O14 measures it.
   - Excused holes are counted in the log (sizes only).
3. *Music or noise with no marker* stays a gap. It costs retries and, at worst, a "may be incomplete"
   notice (the safe direction) or AC-6.7's `failed`.

**Repetition.** D1's rule (H-2) run on one try's tokens. It only flags; removal happens on the chosen
try.

**Detectably incomplete** (AC-6.11) = at least one gap, or at least one repetition.

**Ranking of a part's tries** (AC-6.11): fewest gaps → least total gap time → no repetition before
repetition → the earlier try. Deterministic.

**Final gaps of the meeting** (AC-6.12):
- Start from the chosen try's gaps in every part.
- Inside each such gap, recompute the holes over the union of both versions' trusted words (the
  neighbour's version counts only within the overlap). A gap of part k that part k+1 transcribed is
  not missing from the stitched transcript.
- Keep a resulting hole only if its credited sound is still at least 20 s; its range is then
  computed as above.
- Merge ranges that touch or overlap, across part boundaries too.
- Ranges are in meeting time (part offsets included). A range is never narrowed by stitching beyond
  what the other version actually covers.

**AC-6.7.**
- An empty stitched transcript with no final gap is `noSpeech`.
- An empty stitched transcript with any final gap (after the retries) is `failed` with the new code
  **`speech_not_transcribed`**. "No speech detected" is never shown for it. It is permanent for the
  job: the runner does not re-run the attempt, because each part has already had 3 tries. The
  creator's retry (AC-6.9) stays available while the audio is kept.

> **T124 (2026-11-05, real sandbox, 115 min synthetic audio, 3 runs).** H-1: overlaps 62-118 s; D2 dedup lost no speech (overlap recall 100%); 12 of 14 labels joined at 7 boundaries with 0 false joins; refusals came from J0 or provider diarization jitter (R25), safe direction. H-3: at 10-min parts the one real hole (91% recall) was detected (marked range ~1.5 min wider than the true loss, safe direction); at 19-min parts a 6.7% loss with 1046 untimed words went undetected (untimed-word credit, R24). The provider also returns "repetition tails" as untimed words; D1 removed them only when the first word was timed. D1 twice removed real speech of two different speakers saying the same 8 words ~2 s apart. H-4: all 8 re-tries of flagged parts were byte-identical to try 1 (deterministic provider) — about USD 1.4 for no improvement; 5 of 7 flagged parts were repetition-only. **Decided by the user 2026-11-05 (spec A8):** per-part retries disabled (tries = 1) until production data exists; a repetition never flags a part; duplicates require the same (or no) speaker label; untimed repeated tails are removed by content. Billed 221.6 min ≈ USD 3.55.

### H-4 Per-part retry inside one job attempt

**Where the results live.** All tries of all parts run inside **one claim** of the `transcribe` job
(ADR-0062 attempt n). Per-part results (the best try so far and the current one: words only, about
27 k words for 3 h) are held in **process memory** and nowhere else. Nothing is written to Postgres
until the single commit (G-11, unchanged guards: `ctx.commit` claim re-check,
`WHERE status='processing'`).
- If the lease is lost or the process dies, everything held is dropped, and the next claim starts
  over.
- ADR-0070's "no per-part result is stored between attempts" therefore still holds between **job**
  attempts, and now explicitly within one: no partial transcript is ever at rest in our database.

**Flow per part** (replaces G-2 steps 3–8 for one part; the parts still run in parallel):
1. Upload `in/<k>.ogg` once (`ifGenerationMatch=0`).
2. For try t = 1..3:
   - submit with output prefix `transcribe/<id>/<attempt>/out/<k>-<t>/`, a prefix of its own;
   - poll, then read the output (≤ 8 MiB), which must lie under **that try's** prefix;
   - **delete that try's output prefix at once**, then `operations.delete` (best effort, G-2);
   - map to words, run H-3, keep the result if it ranks better;
   - stop when complete.
3. When the part settles, delete `in/<k>.ogg` at once, without waiting for the other parts.
4. The attempt's `finally` deletes the attempt prefix as today. `deleteAttemptsBefore` at the start is
   unchanged.

**AC-4.12.** Each try is "a transcription attempt like any other": its output copy exists only until
it has been read, and its input copy only until the part's last try ends. The input is reused only
by the tries that immediately follow one another. The crashed-attempt bound (next attempt, or the 1-day lifecycle) and "delete
first, else 503" on explicit deletion are unchanged, because every new key is under
`transcribe/<id>/`. `transientKeys` and the key and output-prefix patterns gain `out/<k>-<t>/` and
lose the bare `out/`.

**Errors on a try** (AC-6.9). A provider error on **try 1** is, as before, the failure of the whole
attempt (transient → the runner retries the job; permanent → `failed`). A provider error on **try 2
or 3** is an improvement that did not happen, not a failure: the part settles with its best try
(still incomplete, so it is marked), and the code is logged. A lost lease always aborts.

**Not AI requests (AC-13.4).** No `ai_request` row is written by transcription, retries included
(unchanged). The stage stays `transcribing` throughout (AC-6.10).

**Quota and polling** (replaces the G-9 worst case; 2 jobs × 22 parts would exceed 150 operation GETs
per minute at a 10 s poll):
- a process-wide semaphore `SPEECH_MAX_INFLIGHT` = 24 operations (in `googleSpeech.ts`), shared by
  first tries and retries;
- the first poll at 30 s, then every 15 s (Google-side median 72 s, p95 85 s). That gives at most
  96 GETs a minute and at most 24 submits a minute, below quota;
- the 45 min per-try deadline is unchanged; the lease is heartbeated meanwhile.

**Latency.** One 3 h job runs its 22 parts at once. A retried part adds about 90 s per try, so the
worst case is +3 min. The target (≤ 3 min + 0.2 × duration, p95) holds for long meetings. It is tight
only for a 10-min meeting whose single part needs all 3 tries (about 5 min); that is rare, so p95
holds. T124 measures it.

**O13 (b).** Every try leaves Google one more transcription result under the ~5-day bound. This is
disclosed by the existing AC-4.1 text (no consent version bump) and added to sign-off H4's question.

### H-5 Data model (one new migration, `*_transcript_quality`; existing migrations untouched)

| Change | Why |
|---|---|
| `meeting.transcriptPartEndsMs Int[] NOT NULL DEFAULT '{}'`, paired with `transcriptPartStartsMs` (now overlapping) | `parts[].endMs`; replaced with the segments, `{}` as before for text/noSpeech |
| `transcript_segment.part Int NULL` (1-based; null for `text` meetings and pre-migration rows) | the joined label's coverage (AC-6.16), "Separate by part", dividers |
| new `transcript_gap (id, meetingId → meeting ON DELETE CASCADE, startMs Int, endMs Int)`, `@@index([meetingId, startMs])` | the final gaps (AC-6.12). Written in the transcribe commit with the segments, under the same replace-never-append rule. Deleted with the meeting (cascade, AC-6.12/4.6); never edited (AC-6.3 does not touch it) |
| `speaker_label.defaultIndex Int NULL` | a separated label that inherits an unnamed "Speaker n" (H-0). A rename sets participant/text and clears it; a reset deletes the row (unchanged) |
| `summary.transcriptGaps Json NOT NULL DEFAULT '[]'` | the ranges the summary was built under (AC-7.13). A self-describing snapshot, the same posture as the template snapshot (AC-7.5) |
| conversation `answer` JSON gains `possiblyIncomplete: boolean` (no column) | AC-9.9; an absent field on older rows reads false |
| `TranscriptionFailureCode` gains `speech_not_transcribed` (code, not a column) | AC-6.7 |

**Derived on read, never stored** (ADR-0013 lineage):
- *possibly incomplete* = the meeting has gap rows;
- a key is **joined** when its segments come from more than one part, and `parts` = those parts in
  order;
- a later label is **separate** when its key's lowest part is > 1;
- the AC-6.15 notice = more than one part and at least one separate later label.

Joins are decided once, in the transcribe commit. A `ready` meeting is never transcribed again (the
retry route accepts only `failed`), so **separating cannot be undone by later processing** (AC-6.16).
A test pins it: the transcribe handler returns for a `ready` meeting.

**Edits, renames and separation (AC-6.3, AC-6.8).**
- A text edit bumps `transcriptVersion` (stale summaries, unchanged) and never touches `part`, keys
  or gaps.
- A rename and "Separate by part" change labels, not text. They do **not** bump `transcriptVersion`
  (G-3 posture). Summaries keep the names they were made with (`speakerNames` snapshot), and asks
  read names live.
- Default numbering: `label.default.index` becomes the **key's own number** (or `defaultIndex`), no
  longer its position in first-appearance order. The values are identical for every existing
  transcript (keys are numbered by first appearance), and a separation then never renumbers other
  speakers. `speakerNamesFor` returns `Speaker <defaultIndex>` for such rows.

### H-6 API contract changes (additive; OpenAPI updated)

`GET /meetings/{id}/transcript`:
```ts
{ version, segments: [{ …unchanged, part: number | null }],
  parts: [{ index: number, startMs: number, endMs: number }],          // endMs new; overlapping
  speakers: [{ key, label, parts: number[], joined: boolean }],          // parts: [] for text meetings
  gaps: [{ startMs: number, endMs: number }],                            // [] = no notice; meeting time, merged, ascending
  separateLabels: boolean }                                              // AC-6.15 notice condition
```

`POST /meetings/{id}/transcript/speakers/{key}/separate` (new; AC-6.16). Body: none.
- Guard: `creatorControl` + `openForControl`, identical to the rename. Not visible → 404; visible
  but not the creator, creator without `meetings:access`, or a frozen meeting → **403** (AC-5.8,
  AC-5.11); a failed frozen lookup → 503 `identity_unavailable` (unchanged). The UI hint is
  `can.editTranscript`.
- 409 `not_ready` for a meeting that is not `ready` or is `noSpeech`; 404 when the key does not exist
  here; 409 `not_joined` when the key covers at most one part (so a second call is 409, not a no-op).
- In one transaction, with the meeting row taken `FOR UPDATE` (it serialises with renames):
  - the lowest part keeps the key;
  - each further part, in ascending order, gets the next unused key number, and a `speaker_label` row
    copying the key's participant or text, or `defaultIndex` = the key's number (or its own
    `defaultIndex`);
  - `UPDATE transcript_segment SET speakerKey = <new> WHERE meetingId AND speakerKey = <key> AND part = <p>`.
  - No `transcriptVersion` bump; segment `version`s are unchanged.
- 200 `{ speakers: [...] }` (the GET's shape). Logs: ids and counts only.

`GET` and the writes of summaries return `possiblyIncomplete: { gaps: Range[] } | null`, from
`summary.transcriptGaps`. The **service** writes it, the model never does (AC-7.13). When gaps exist
at generation time:
- `validateSummaryOutput` renders an empty section as `NOT_FOUND_INCOMPLETE[lang]` ("Not found in the
  transcript, which may be incomplete" / "Non trovato nella trascrizione, che potrebbe essere
  incompleta"), in place of `NOT_DISCUSSED`;
- the summarize job reads the gaps with the transcript, under the same version-stable read, and
  snapshots them;
- a regeneration snapshots again, so it carries them too.

Turns return `answer.possiblyIncomplete: boolean`. When it is true and the answer is "not in the
meeting", the fixed text is `NOT_IN_MEETING_INCOMPLETE[lang]` ("The transcript does not contain an
answer to this question. It may be incomplete, so the meeting itself may." / "La trascrizione non
contiene una risposta a questa domanda. Potrebbe essere incompleta, quindi la riunione potrebbe
contenerla."). It is server-written, in the question's language (AC-9.9). Both fixed texts are
constants beside the existing ones. The eval fixtures have no gaps, so their fixed-text assertions
are unchanged. `Range` = `{ startMs: number, endMs: number }` in meeting time.

Meeting view: `failureCode` may be `speech_not_transcribed`. No host notice, notification or list
carries anything about incompleteness (non-goal; AC-11.8 unchanged).

**Rejected:** telling the model where the gaps are (a server-written `[GAP …]` line in the
transcript block). It would change the eval baseline and add an unforgeable-marker problem to the
escaping rules, while the guarantee is the service-written label either way. A named follow-up,
triggered by summaries that treat a gap's absence as fact despite the label.

### H-7 UI contract (meetings-ui)

- **Notice (AC-6.12 a, c).**
  - Shown when `gaps.length > 0`: a `Banner tone="warning"` above the transcript, with no dismiss
    and the anchor id `meetings-transcript-incomplete`.
  - Copy: "This transcript may be incomplete. Speech may be missing between {a} and {b}[, and between
    …]. The missing speech is not in the transcript and cannot be recovered from it."
  - Each range has a play control while the audio is kept (AC-6.5's seek); it is absent after audio
    deletion.
- **Markers (AC-6.12 b).** "Possible gap {a}–{b}", placed before the first segment whose start is at
  or after the gap's start, between lists (the T108 WCAG 1.3.1 pattern), with the same play control.
  Times use `formatDuration` clock style.
- **Parts notice (AC-6.15).** The info `Banner` now shows only when `separateLabels`. New copy: "This
  recording was transcribed in {n} parts. Speakers could not always be matched between parts, so one
  person can appear under two labels. Rename them to the same name to merge them." It never says
  "numbered separately" or "different people". The Italian is in the strings module.
- **Dividers.** "Part {n} · {start}" goes before the first segment (by ordinal) whose `part` is n,
  using `segment.part`, no longer the time-based `partStartingAt` (overlapping parts make time
  ambiguous).
- **Joined label (AC-6.16).**
  - Wherever a speaker is listed or renamed, a joined key shows "Matched automatically across parts
    {1–3}" (an `Icon` plus text, not colour alone).
  - The creator (`can.editTranscript`) gets "Separate by part": a `ConfirmDialog` explains that each
    part's speech gets its own label, keeping the current name until renamed. It then POSTs, replaces
    the speakers and reloads the transcript.
  - Each separated label shows its part.
- **Copy and download (AC-6.6).** `exportText` takes `gaps`. The text begins with the notice (in the
  UI language) and a blank line, and carries `[Possible gap hh:mm:ss–hh:mm:ss]` lines at the same
  places as on screen.
- **Summaries (AC-7.13).** A card with `possiblyIncomplete` shows the label "Based on a transcript
  that may be incomplete" with its ranges, beside "AI-generated". `summaryText` (copy) includes the
  label and the ranges.
- **Answers (AC-9.9).** A turn with `answer.possiblyIncomplete` shows the same label with a link to
  `#meetings-transcript-incomplete`. The answer text is the server's.
- **Failure copy.** `speech_not_transcribed`: "Speech was detected in the recording but could not be
  transcribed." / "Nella registrazione è stato rilevato del parlato, ma non è stato possibile
  trascriverlo."
- **Strings.** All copy goes in `strings/transcript.ts`, `summaries.ts`, `ask.ts` and `meeting.ts`,
  `it: typeof en`, with the parity and no-hardcoded-copy tests (AC-13.1).

### H-8 D4: Claude on Vertex with one unforced tool (replaces G-4's `tool_choice` line and G-8's last row)

**Request** (`vertexClaude.ts`):
```ts
messages.create({ model, system, messages, max_tokens, tools: [<the one output schema>] })
// no tool_choice, no thinking, no cache_control, no betas, no server tools, no advanced_ai_enabled
```
- **`tool_choice` omitted.** It is the only shape the spike saw accepted. An explicit
  `{type:"auto", disable_parallel_tool_use:true}` would reduce double calls, but it is unverified on
  this model. It may be adopted only after T120 records a 200 for it from the pinned model; until
  then, a double call is simply invalid.
- **`thinking` omitted, never sent.** `disabled` is refused. The spike reports the model wants an
  adaptive mode or nothing, and sending an enabling value would add cost and a second unverified
  parameter. Thinking blocks the model returns anyway (`thinking`, `redacted_thinking`) are
  **discarded unread**: never validated as output, stored or logged (they can echo the transcript,
  AC-4.10).
  - The risk is a reply cut off at `max_tokens`. The live eval asserts no `max_tokens` stop across the
    fixtures. If one appears, `SUMMARY_MAX_TOKENS`/`ANSWER_MAX_TOKENS` are raised, and the thinking
    parameter is not touched.
- The prompts are unchanged. Rules 4 and 6 already say "Answer only by calling the tool …", so the
  injection baseline stays comparable.

**Acceptance rule** (`toolCall(reply, name)`):
- `stop_reason === "tool_use"`, and exactly one `tool_use` block, whose `name` is the offered tool.
- Other blocks are allowed only as `text`, `thinking` or `redacted_thinking`, and are discarded
  unread.
- Any other block type (e.g. `server_tool_use`, which we never offered) is invalid.
- The input then goes to the existing schema validators (`prompts/*.ts`).
- Everything else is `invalid_output`: no call (text only), two calls, another name, a different stop
  reason, or a schema rejection. It is never partial (AC-7.9, AC-9.6).

**One automatic resample, kept.** `OUTPUT_TRIES` = 2 stays in the summarize job and the ask route:
the same request sent again, with no corrective message, because feeding the model's own invalid
reply back would put untrusted text in the request.
- It is one AI request under AC-13.4: one `ai_request` row per user action, as today. A counted
  request costs at most 2 model calls, so a user's worst case is 60 calls an hour.
- The resample is not counted again because AC-13.4 limits what the user asks for. The model's
  failure to comply is the provider's cost, and the 30/h limit already bounds it at ×2.
- The ask route's 90 s limit covers both samples (unchanged).
- The adapter logs each rejected reply with a closed reason (`[ai] invalid_output
  reason=no_call|multiple_calls|wrong_tool|stop_reason|block_type`), never content, so the unforced
  rate is observable in production. Schema rejections stay unlogged, as today.

**ADR-0067 amendment text (for the adr-writer).** Point 3 reads: "Structured output through a single
offered tool. The tool is only the output schema. The reply is accepted only as exactly one call of
that tool, stopped for tool use, whose input passes the schema validator. Text-only replies, missing
or repeated calls, another tool, or any other stop are `invalid_output`: sampled once more, then
`failed`. Forcing the call (`tool_choice`) is used only where the pinned model supports it and is
never relied on: the guarantee is the validation, not the mechanism. Reasoning output (thinking) is
discarded unread." Point 6 adds the unforced-reply fixtures and the availability tier (H-10). The
other points are unchanged.

### H-9 Risks (delta; R1–R22 stand, R20 is replaced)

| # | Risk | Mitigation / early check |
|---|---|---|
| R20 (replaced) | A false join: one person's words under another's label in the transcript and in every summary | J2 (a)–(c) are strict, and J0 rules out overlaps with a 20 s hole; text only. The joined indication shows which parts a label covers, and "Separate by part" repairs it. **O14 (T125) measures the join error rate on consented recordings before go-live; a false join found then is a defect** (spec), fixed by tightening the rule, never by tuning past it |
| R23 | Detector false positives: music or noise with no provider marker reads as a gap, causing needless retries, a false notice, or `speech_not_transcribed` on a noise-only recording | Speech-band filter; the noise-marker excuse; the cost is bounded (H-1). The notice says "may", the safe direction. O14 measures the rate |
| R24 | Detector false negatives: an omission under 20 s; a provider marker inside untranscribed speech; untimed-word credit masking a hole | Spec: no notice is not a promise (AC-6.12, non-goal). Excused holes and credits are counted in logs. O14 compares the detector with listened ground truth. T124 regresses the spike's known holes (18–19 min parts) |
| R25 | Diarization jitter at turn boundaries blocks most joins (word-level (b)) | Safe direction (renames). O14 reports the join rate and, if low for this reason, a spec amendment is proposed (H-0) |
| R26 | Seam text transcribed differently by the two versions appears twice | Spec-mandated union. The 90 s overlap and both edges in pauses reduce it. Visible and editable |
| R27 | Cost +15–17 % from overlap, plus retries, plus the job-level worst case | Bounds stated (H-1). Google billing alert on the project. Retries settle on the best try, never loop |
| R28 | Unforced tool use: a higher invalid rate, an injection pushing a text reply (availability, not integrity), a model update changing behaviour | Acceptance rule plus one resample. The eval's availability tier and unforced-reply fixtures; the model change is gated by the live eval (ADR-0067); `invalid_output` rate in the logs |
| R29 | Speech quota exceeded when two long jobs run | `SPEECH_MAX_INFLIGHT` = 24 with a 15 s poll: ≤ 96 GETs/min |
| R30 | Thinking consumes `max_tokens`, so replies are cut | Eval asserts no `max_tokens` stop; raise the constant |

### H-10 Test strategy (delta)

**Fixtures.**
- T124 records, from synthetic it/en audio with the spike, two consecutive **overlapping** part
  outputs per language (2 speakers and 3 speakers), one 18–19-min part with a known hole, and the
  silencedetect list of each input. They are scrubbed as in G-12.
- Unit cases are hand-built **in the recorded shape**: one result per part; words with string
  offsets; the proto3 zero omitted; `speakerLabel` strings starting at 0 or 1; a lone `[`; the
  T107 garbled offsets.

| AC | Level | What proves it |
|---|---|---|
| AC-6.2 | unit + integration + component | `chooseParts`: 22 parts for 10 860 s, every part ≤ 10 min, overlaps in [60, 120] s, edges in pauses when available; joined keys share key and name; separate later labels take new numbers; numbering is by root first appearance |
| AC-6.1, AC-6.5 | unit | stitched segments have non-decreasing starts across every seam and a start never later than their first trusted word; a segment never spans a gap |
| AC-6.13 | unit | D1: 8 equal words 1.5 s apart removed; the same 2.5 s apart kept; 7 words kept; an untimed boundary kept; first kept. D2: an overlap duplicate appears once; tokens found in one version only kept from both sides; a phrase said twice in the overlap keeps both copies; a remaining repetition does not create a gap |
| AC-6.14 | unit | 20 matched words, all to one L1, no rival → joined; chain p3 → p2 → p1 only via consecutive overlaps; a part-3 label never joins part 1 directly |
| AC-6.15 | unit + component | separate on: 19 words; one word to another L1; two L2 to one L1; no speech in the overlap; a 20 s untimed stretch in the overlap (J0). Banner only when `separateLabels`; copy has neither forbidden phrase |
| AC-6.17 | unit (**replay**) + static | the recorded overlap outputs run through the stitcher with three silence lists (none, the recorded one, all-sound) and two different audio files → byte-identical joins and segments' speaker keys; `stitch.ts` imports nothing from `src/media` and its join input type has no audio field |
| AC-6.11 | unit + integration | fake Speech replies scripted per try: complete try 1 → one submit; gap then complete → two; three incomplete → three, best kept by ranking (each tie level tested); a complete part never resubmitted; an error on try 2 settles with try 1; no `ai_request` rows; stage `transcribing` throughout |
| AC-6.12 | unit + integration + component | gap ranges in meeting time; merged across a boundary; a part-k gap covered by part k+1 is not reported; `transcript_gap` rows written in the commit and cascaded on delete; notice and markers render, play controls absent after audio deletion, notice not dismissable, unchanged by a segment edit |
| AC-6.7 | unit + integration | empty with no sound ≥ 20 s → `noSpeech`; empty with sound and no marker after 3 tries → `failed` `speech_not_transcribed`, `PermanentJobError`, "No speech detected" absent; markers only → `noSpeech` |
| AC-6.9, AC-6.10 | integration | try-1 provider error → whole attempt fails as before; no segments; stage stays `transcribing` |
| AC-4.12 | unit (fake transient storage) | each try's `out/<k>-<t>/` deleted right after its read; `in/<k>.ogg` deleted when the part settles; the attempt prefix in `finally`; an output URI under another try's prefix refused |
| AC-6.16 | integration + component | separate → each part's segments get their own key, names copied (participant, text, `defaultIndex`); 403 for a participant, a creator without access and a frozen meeting; 409 `not_joined` on the second call; a later processing path cannot rejoin; rename on a joined key renames every part |
| AC-6.6 | component | copy and download begin with the notice and carry markers in place |
| AC-7.13, AC-9.9 | unit + integration + component | the summary snapshot `transcriptGaps`; `NOT_FOUND_INCOMPLETE` in place of `NOT_DISCUSSED`; regenerate carries it; answer `possiblyIncomplete` and `NOT_IN_MEETING_INCOMPLETE`; labels in the copied text; the link targets the notice anchor |
| AC-7.9, AC-9.6 | unit (wire-level, recorded reply shapes) | no `tool_choice`/`thinking` in the body; accepted: one call (with text or thinking blocks discarded); `invalid_output`: text only, two calls, another name, `max_tokens` stop, `server_tool_use`; one resample then `failed`; one `ai_request` row per request |
| AC-7.12, AC-9.7 | eval | the 53 fixtures plus new channels: "answer in plain text", "call the tool twice", "call `web_search`" → the outcome is invalid or the template is followed, never injected text shown |
| AC-4.10 | unit | the log canary through `completeness.ts`, `stitch.ts`, the new route and the thinking-block discard |

**Spike regression (T124, a release gate outside the AC map).**
- The spike gains `--reference <script.txt>`: per-part word ratio against the known script, detector
  verdicts, retries, joins, dedup counts and timings, printed without content.
- Pass:
  - at 19-min parts the known holed parts are flagged;
  - at 10-min parts with overlap, every part ≥ 95 % after retries, or flagged;
  - zero false joins on the scripted speakers;
  - job latency within the target.

**Live eval (gate, ADR-0067).** `bun run eval --live` on the pinned `MEETINGS_VERTEX_MODEL_ID`, run
twice. The gate:
- zero safety findings;
- no `max_tokens` stop;
- the **availability tier**: at most 2 of the 53 (+ new) fixtures ending `invalid_output` after the
  resample, per run;
- the first-sample tool-call rate recorded in the PR.

### H-11 Security (delta; still YES, frontier tier for this delta)

- **No new processor, no new data class, no voice characteristic.** Joins read text, labels and times
  only (static test, AC-6.17). The detector reads silence timestamps, our own energy measure, never a
  voice feature.
- **New surface:** `POST …/speakers/{key}/separate`, `creatorControl`, meeting-scoped key, identical
  404, serialised by row lock. The owasp review covers it with the rename route.
- **Untrusted provider output** now drives O(n²)-shaped work:
  - a part's output over `MAX_WORDS_PER_PART` = 8 000 words is `provider_rejected`;
  - D1 uses an 8-gram index;
  - D2's windows are bounded by the overlap (≤ ~600 tokens).
- **Gap ranges** are content-adjacent metadata (when someone spoke). They live in the meeting's
  rows, are deleted with it and are never logged, notified or sent to a host.
- **Transient bucket:** each try reads only under its own prefix; deletions are tighter than before
  (per try, per part); the key patterns are narrowed.
- **Vertex:** thinking blocks are discarded unread and never logged; unforced replies cannot widen
  capability (still one schema tool, no server tool, and any `server_tool_use` block is refused).
- Surfaces for the owasp pass: the separate route; `stitch.ts`/`completeness.ts` input bounds;
  `vertexClaude.ts` acceptance; `transientStorage.ts` patterns.

### H-12 ADR candidates

14. **Amend ADR-0067: single tool offered unforced; validation is the guarantee**
    (`docs/adr/0067-ai-output-structured-validated-plain-text.md`, amendment section; text in H-8).
    - The rule: a guarantee must rest on what the application checks, not on a provider feature
      that a model may drop.
    - *Rejected:*
      - keeping forced `tool_choice` by pinning an older model that supports it (it ties model choice
        to a mechanism, and the eval, not the mechanism, is the gate);
      - free-text JSON parsed from a text reply (loses the schema channel; a text answer then looks
        valid);
      - feature-detecting forcing at runtime (two untested paths);
      - a corrective second turn that quotes the invalid reply (feeds untrusted output back into the
        request);
      - counting the resample as a second AI request (it charges the user for the model's failure).
15. **Amend ADR-0070: overlapping parts and text-evidence joins, separable by the creator**
    (`docs/adr/0070-meetings-transcript-parts-speaker-labels-per-part.md`).
    - Option D (overlap alignment) becomes the decision; the "never carried over" rule becomes
      "joined only on clear text evidence (AC-6.14), otherwise separate".
    - The failure shape is unchanged and now has a repair path ("Separate by part") and a visible
      indication.
    - The consequence "no per-part result is stored between attempts" is restated: per-part tries
      live in memory within one claim.
    - *Rejected:*
      - joining by position or number;
      - voice embeddings (GDPR art. 9);
      - majority vote instead of J2 (b)/(c) (it tolerates a false merge);
      - using the audio-based gap for J0 (it would break AC-6.17).
16. **New ADR-0073: a transcript that cannot be proven complete says where it may not be; detect,
    retry bounded, then mark** (`docs/adr/0073-meetings-transcript-completeness-detect-retry-mark.md`).
    - Decision: the energy-vs-word-timeline detector, the provider's noise marker as a positional
      excuse, 3 tries per part held in memory, the best try kept by a fixed ranking, final gaps
      stored and shown, and service-written caveats on everything derived (summaries, answers,
      copies). Failure shape: a silent omission consumed downstream as a complete record.
    - *Rejected:*
      - re-transcribing the whole meeting on a gap (the cost, and it discards nothing better);
      - a VAD or speech model of our own (new processing; not needed for an energy bound);
      - storing per-part tries in Postgres to survive a crash (a partial transcript at rest);
      - telling the model about gaps (H-6);
      - hiding gaps behind a setting.
17. **Notes, not ADRs** (the adr-writer appends follow-up notes):
    - ADR-0062: `transcribe` runs up to 3 tries per part inside one claim, holds them in memory and
      writes no `ai_request`;
    - ADR-0064: the silence pass runs on every recording, band-limited, and parts are cut by output
      seeking; still our own derived file, so the trigger is not tripped;
    - ADR-0069: per-try output prefixes, input deleted per part, `SPEECH_MAX_INFLIGHT`.
- **AGENTS.md:** the 0073 line, and the 0067/0070 lines' amendment notes (T126).

### H-13 Open questions for the user

- **QH-1 (O14 logistics; before go-live).** O14 needs real recordings made for the purpose, with a
  consent attestation.
  - Proposal: ≥ 10 recordings, ≥ 8 h in total, Italian and English, in-person and online, 2–5
    speakers, at least 3 over 1 h.
  - The architect listens to a sample of the flagged and unflagged stretches and counts false joins.
  - Who records, and may wellD staff serve as participants?
- **QH-2 (eval gate threshold).** H-10 proposes that up to 2 of ~55 fixtures may end `invalid_output`
  after the resample (a safe failure with Retry), with zero tolerance on safety findings. Accept it,
  or require zero?
- Everything else is decided above. The cost delta (+15–17 %, worst case stated) is for your
  information.

### H-14 Task-list delta (for the re-sync; tasks.md is not edited here)

**Superseded / reopened.**
- T108's banner copy and condition and its time-based dividers are superseded by T122 (keep `[x]`,
  with the note "superseded 2026-11-05 (A7), see T122").
- The T107 note's "a hole detector is a named follow-up" is delivered by T114.
- The G-3 bullet "Named follow-up … overlapping parts" is delivered by T113/T115.
- **T92 gains deps T113–T127.**

- [ ] T113: [BE] Overlapping parts: `chooseParts` (H-1), per-part output-seek stream copy (retires the segment muxer and `parts.csv`), silence pass on every recording with the speech-band filter, `splitAudio` returns `{parts {path,startMs,endMs}, silences, durationMs}` — refs: AC-6.2, AC-6.11, AC-6.14 — deps: none
  - touch: `meetings-api/src/media/split.ts`, `meetings-api/src/media/split.test.ts`, `meetings-api/src/media/split.real.test.ts`
  - done when: `bun test src/media/split` passes with cases "10 860 s → 22 parts, each ≤ 600 s, overlaps within [60, 120] s, edges in pauses when offered", "≤ 10 min → 1 part and a silence list"; `split.real.test.ts` (ffmpeg image) cuts a 75 s fixture with `PIECE_MAX_MS` 30 s and overlap 10 s and ffprobe durations match ± 40 ms
- [ ] T114: [BE] `src/ai/words.ts` (word model, normalisation, effective times) and `src/ai/completeness.ts` (holes, credited sound, noise-marker excuse, repetition D1 detection, try ranking, final-gap subtraction and merge) — refs: AC-6.7, AC-6.11, AC-6.12, AC-6.13 — deps: none
  - touch: `meetings-api/src/ai/words.ts`, `meetings-api/src/ai/words.test.ts`, `meetings-api/src/ai/completeness.ts`, `meetings-api/src/ai/completeness.test.ts`
  - done when: `bun test src/ai/words.test.ts src/ai/completeness.test.ts` passes with the AC-6.7/6.11/6.12 rows of H-10 (each ranking tie level, a lone `[` excusing a hole, 600 ms credit, cross-boundary merge, neighbour coverage subtraction)
- [ ] T115: [BE] `src/ai/stitch.ts`: D1 removal, D2 alignment and union, J0–J5 joins, segments split at gaps with `part`; `mapPhrases` keeps `part` on `DraftSegment` — refs: AC-6.2, AC-6.13, AC-6.14, AC-6.15, AC-6.17 — deps: T114
  - touch: `meetings-api/src/ai/stitch.ts`, `meetings-api/src/ai/stitch.test.ts`, `meetings-api/src/ai/segments.ts`, `meetings-api/src/ai/segments.test.ts`
  - done when: `bun test src/ai/stitch.test.ts src/ai/segments.test.ts` passes with the AC-6.13/6.14/6.15 rows of H-10 and the static "no `src/media` import, no audio field" check
- [ ] T116: [BE] Google adapter per-part tries (H-4): per-try output prefix read and deleted at once, input deleted per part, try-2/3 errors settle on best, `SPEECH_MAX_INFLIGHT` semaphore and 30 s/15 s polling, `MAX_WORDS_PER_PART`, words → `completeness` → `stitch`; the outcome gains `parts {startMs,endMs}[]`, `gaps`, segment `part`; `speech_not_transcribed`; `transientKeys` patterns `out/<k>-<t>/`; `FakeTranscriber` scriptable gaps, parts and joined keys — refs: AC-4.12, AC-6.7, AC-6.9, AC-6.10, AC-6.11, AC-13.4, AC-4.10 — deps: T113, T114, T115
  - touch: `meetings-api/src/ai/googleSpeech.ts`, `meetings-api/src/ai/googleSpeech.test.ts`, `meetings-api/src/ai/transcriber.ts`, `meetings-api/src/ai/fakeTranscriber.ts`, `meetings-api/src/lib/google/transientStorage.ts`, `meetings-api/src/lib/google/transientStorage.test.ts`, `meetings-api/test-fixtures/google-speech/overlap-*.json`
  - done when: `bun test src/ai src/lib/google` passes with the AC-6.11 and AC-4.12 rows of H-10 (fake Speech scripted per try; fake transient storage records per-try and per-part deletions) and "at most 24 operations in flight across two concurrent transcribers"
- [ ] T117: [BE] Migration `*_transcript_quality` (H-5: part ends, `segment.part`, `transcript_gap`, `speaker_label.defaultIndex`, `summary.transcriptGaps`); the transcribe commit writes them (replace, never append); `speech_not_transcribed` is permanent; transcript GET adds `parts[].endMs`, `segments[].part`, `speakers[].parts/joined`, `gaps`, `separateLabels`, and default index = key number; OpenAPI — refs: AC-6.2, AC-6.7, AC-6.12, AC-6.15, AC-6.16 — deps: T116
  - touch: `meetings-api/prisma/schema.prisma`, `meetings-api/prisma/migrations/*_transcript_quality/*`, `meetings-api/src/jobs/handlers/transcribe.ts`, `meetings-api/src/jobs/handlers/transcribe.test.ts`, `meetings-api/src/transcript/transcript.routes.ts`, `meetings-api/src/transcript/transcript.test.ts`
  - done when: on `meetings_test`, `bun run db:deploy && bun test src/jobs/handlers/transcribe.test.ts src/transcript` passes: gaps rows written and cascaded on delete; a retry replaces them; `separateLabels` true iff a key's lowest part > 1; legacy rows (part null) read as not joined; a `ready` meeting is not re-transcribed
- [ ] T118: [BE] `POST /meetings/{id}/transcript/speakers/{key}/separate` (H-6) with row lock, name copy incl. `defaultIndex`; `speakerNamesFor` honours `defaultIndex` — refs: AC-6.16, AC-5.8, AC-5.11, AC-6.2 — deps: T117
  - touch: `meetings-api/src/transcript/transcript.routes.ts`, `meetings-api/src/transcript/separate.test.ts`, `meetings-api/src/meetings/promptSegments.ts`, `meetings-api/src/matrix.test.ts`
  - done when: on `meetings_test`, `bun test src/transcript/separate.test.ts src/matrix.test.ts` passes: the AC-6.16 row of H-10, and the route appears in the authorization matrix (creator 200, participant 403, frozen 403, stranger 404)
- [ ] T119: [BE] Service-written caveats: the summarize job snapshots `transcriptGaps` and renders `NOT_FOUND_INCOMPLETE`; the ask route stores `possiblyIncomplete` and uses `NOT_IN_MEETING_INCOMPLETE`; summary and turn responses carry them — refs: AC-7.13, AC-9.9, AC-7.4 — deps: T117
  - touch: `meetings-api/src/jobs/handlers/summarize.ts`, `meetings-api/src/jobs/handlers/summarize.test.ts`, `meetings-api/src/ai/prompts/summary.ts`, `meetings-api/src/ai/prompts/summary.test.ts`, `meetings-api/src/ai/prompts/answer.ts`, `meetings-api/src/ai/prompts/answer.test.ts`, `meetings-api/src/summaries/summaries.routes.ts`, `meetings-api/src/summaries/summaries.test.ts`, `meetings-api/src/conversation/conversation.routes.ts`, `meetings-api/src/conversation/conversation.test.ts`
  - done when: on `meetings_test`, these tests pass with the AC-7.13/9.9 rows of H-10, including "regenerate carries the snapshot" and "a meeting without gaps returns `possiblyIncomplete: null`/false and the old fixed texts"
- [ ] T120: [BE] Vertex unforced single tool (H-8): no `tool_choice`, no `thinking`; the acceptance rule; thinking blocks discarded unread; the `invalid_output` log line; recorded reply-shape fixtures (scrubbed, synthetic content) from the pinned model, including whether explicit `auto` + `disable_parallel_tool_use` is accepted (recorded, not adopted) — refs: AC-7.9, AC-9.6, AC-7.10, AC-13.4, AC-4.10 — deps: none (it changes only the adapter; the resample paths in `summarize.ts`/`conversation.routes.ts` stay as they are)
  - touch: `meetings-api/src/ai/vertexClaude.ts`, `meetings-api/src/ai/vertexClaude.test.ts`, `meetings-api/src/ai/languageModel.ts`, `meetings-api/test-fixtures/google-vertex/messages-*.json`, `meetings-api/test-fixtures/google-vertex/README.md`
  - done when: `bun test src/ai/vertexClaude.test.ts` passes with the AC-7.9/9.6 row of H-10, and `git grep -n "tool_choice\|thinking" meetings-api/src/ai/vertexClaude.ts` matches only comments
- [ ] T121: [QE] Evals: new channels (plain-text reply, double call, other tool) in en/it; the availability tier; a `max_tokens`-stop assertion in the live run; a live run on the pinned model, twice, recorded in the PR — refs: AC-7.12, AC-9.7, AC-7.9, AC-9.6 — deps: T120
  - touch: `meetings-api/evals/assertions.ts`, `meetings-api/evals/types.ts`, `meetings-api/evals/fixtures/summary.en.ts`, `meetings-api/evals/fixtures/summary.it.ts`, `meetings-api/evals/fixtures/answer.en.ts`, `meetings-api/evals/fixtures/answer.it.ts`, `meetings-api/evals/run.ts`, `meetings-api/evals/eval.test.ts`
  - done when: `bun run eval` (fake) exits 0; `bun test evals/eval.test.ts` passes; the live run's summary (safety 0, availability ≤ 2, no `max_tokens`, first-sample tool-call rate) is in the PR description
- [ ] T122: [FE] meetings-ui transcript: types, the notice with ranges and play controls, gap markers, the new parts-banner rule and copy, dividers by `segment.part`, the joined indication and "Separate by part" dialog, export with notice and markers, `speech_not_transcribed` copy, en/it — refs: AC-6.2, AC-6.6, AC-6.7, AC-6.12, AC-6.15, AC-6.16, AC-13.1 — deps: none (contract H-6)
  - touch: `meetings-ui/src/components/transcript/TranscriptView.tsx`, `meetings-ui/src/components/transcript/TranscriptView.test.tsx`, `meetings-ui/src/components/transcript/exportText.ts`, `meetings-ui/src/components/transcript/SpeakerRenameDialog.tsx`, `meetings-ui/src/components/transcript/SeparateSpeakerDialog.tsx`, `meetings-ui/src/components/transcript/Corrections.test.tsx`, `meetings-ui/src/strings/transcript.ts`, `meetings-ui/src/strings/meeting.ts`, `meetings-ui/src/lib/types.ts`, `meetings-ui/src/lib/meetingsApi.ts`, `meetings-ui/src/test-support/fakeApi.ts`
  - done when: `cd meetings-ui && pnpm lint && pnpm build && pnpm test` passes with new cases: no gaps → no notice; two gaps → notice and markers in place, no dismiss, no play after audio deletion; banner only with `separateLabels` and without the forbidden phrases; Separate shown only with `can.editTranscript`; the exported text starts with the notice; `catalogGaps` parity
- [ ] T123: [FE] meetings-ui summary and answer caveat labels, the link to the notice, labels in copied text — refs: AC-7.13, AC-9.9, AC-7.11 — deps: T122 (shared `lib/types.ts`, `fakeApi.ts`)
  - touch: `meetings-ui/src/components/summaries/SummaryCard.tsx`, `meetings-ui/src/components/summaries/Summaries.test.tsx`, `meetings-ui/src/components/ask/Turn.tsx`, `meetings-ui/src/components/ask/Ask.test.tsx`, `meetings-ui/src/strings/summaries.ts`, `meetings-ui/src/strings/ask.ts`, `meetings-ui/src/lib/types.ts`, `meetings-ui/src/test-support/fakeApi.ts`
  - done when: `cd meetings-ui && pnpm lint && pnpm build && pnpm test` passes; the copied summary text contains the label and the ranges; the answer label links to `#meetings-transcript-incomplete`
- [ ] T124: [QE] Spike regression (release gate): `--reference`, detector, retry, join and dedup report without content; records the overlap, hole and silence fixtures; the AC-6.17 replay test on them — refs: AC-6.11, AC-6.12, AC-6.14, AC-6.17 — deps: T116
  - touch: `meetings-api/scripts/spike-google-speech.ts`, `meetings-api/test-fixtures/google-speech/recorded-overlap-*.json`, `meetings-api/test-fixtures/google-speech/recorded-hole-*.json`, `meetings-api/test-fixtures/google-speech/README.md`, `meetings-api/src/ai/stitch.replay.test.ts`
  - done when: `bun test src/ai/stitch.replay.test.ts` passes (three silence lists, two audio files, identical joins); the spike's pass criteria of H-10 are met on the sandbox and recorded in a dated note under H-1 (via the orchestrator)
- [ ] T125: [QE] O14 measurement on consented recordings (QH-1): false-gap, missed-gap and false-join rates; bounds confirmed or changed; outcome in a dated note under H-3 (via the orchestrator). **Go-live gate.** — refs: AC-6.11, AC-6.13, AC-6.14, O14 — deps: T124
  - touch: `meetings-api/scripts/measure-transcript-quality.ts`
  - done when: the note records the three rates on ≥ 8 h, and zero false joins (any false join found is filed as a defect and fixed before go-live); any changed bound is a code constant with its test updated
- [ ] T126: [OPS] ADRs via adr-writer: amend 0067 and 0070, new 0073, follow-up notes on 0062/0064/0069; AGENTS.md ADR lines — refs: AC-6.14, AC-6.11, AC-7.9 — deps: none (after plan approval)
  - touch: `docs/adr/0067-ai-output-structured-validated-plain-text.md`, `docs/adr/0070-meetings-transcript-parts-speaker-labels-per-part.md`, `docs/adr/0073-meetings-transcript-completeness-detect-retry-mark.md`, `docs/adr/0062-durable-job-runner-work-queued-state-derived.md`, `docs/adr/0064-meetings-api-reads-audio-bytes-third-reader.md`, `docs/adr/0069-meetings-ai-providers-google-cloud-eu.md`, `AGENTS.md`
  - done when: each file carries its amendment or note with the rejected alternatives of H-12; `git grep -n "0073" AGENTS.md` matches the ADR list
- [ ] T127: [OPS] Changesets for meetings-api and meetings-ui (A7, D4) — refs: AC-10.5 — deps: T113–T123
  - touch: `.changeset/*.md`
  - done when: `mise run changeset:check` passes

**Overlaps** (all ordered by deps):

| Shared file | Order |
|---|---|
| `src/transcript/transcript.routes.ts` | T117 → T118 |
| `prisma/schema.prisma` + migration | T117 only (T118 and T119 depend on it) |
| `test-fixtures/google-speech/*` | T116 (`overlap-*`, hand-built) → T124 (`recorded-*`, README) |
| `src/ai/segments.ts` | T115 only; T116 consumes it |
| `meetings-ui/src/lib/types.ts`, `src/test-support/fakeApi.ts` | T122 → T123 |
| `src/ai/prompts/summary.ts`, `answer.ts` | T119 only (T120 does not touch prompts or callers) |
| `src/jobs/handlers/summarize.ts`, `src/conversation/conversation.routes.ts` | T119 only |

`split.ts` (T113), `completeness.ts`/`words.ts` (T114), `stitch.ts` (T115), `googleSpeech.ts`,
`transcriber.ts`, `fakeTranscriber.ts`, `transientStorage.ts` (T116), `transcribe.ts` (T117),
`promptSegments.ts` (T118), `vertexClaude.ts` (T120), `evals/*` (T121), the spike script (T124),
`docs/adr/*` and `AGENTS.md` (T126) each have one owner.

**Coverage additions:**
- AC-4.12 → T116;
- AC-6.2 → T113, T115, T117, T122;
- AC-6.6 → T122;
- AC-6.7 → T114, T116, T117, T122;
- AC-6.9/6.10 → T116;
- AC-6.11 → T113, T114, T116, T124, T125;
- AC-6.12 → T114, T117, T122, T124;
- AC-6.13 → T114, T115, T125;
- AC-6.14 → T113, T115, T124, T125;
- AC-6.15 → T115, T117, T122;
- AC-6.16 → T117, T118, T122;
- AC-6.17 → T115, T124;
- AC-7.9/9.6 → T120, T121;
- AC-7.13/9.9 → T119, T123;
- AC-7.12/9.7 → T121;
- AC-13.4 → T116, T120.

## Addendum 2026-11-05 (draft failure.code contract, AC-3.2)

Source: eval rounds 3/4; records what commits 76d6c29 and 77875d7 implement
(`src/jobs/handlers/prepareAudio.ts` `refuseUpload`, `src/meetings/view.ts`,
`src/capture/upload.routes.ts`). Nothing above is rewritten; this addendum takes precedence
over the `failureCode` comment in § Data model and the `failure` field in § API contracts.

**Data model: `Meeting.failureCode` means two things, told apart by `status`.**
- `status = failed`: why processing failed (closed set unchanged). The sources are kept for retry.
- `status = draft`: the **last refusal** of an uploaded file. The only value written today is
  `too_long`. This is not a failure: the meeting can still be edited and take another upload.
- Other statuses (`processing`, `ready`): always `null`. The confirm flip to `processing`
  writes `failureCode = null`.

**When it is written.** `prepare_audio` decodes the local file. If an **uploaded** source is over
3 h (`NormalizeError too_long`), `refuseUpload` runs these steps in order:
1. A guard commit proves this attempt still owns a `processing` meeting. If not, the result is
   "stale", nothing changes, and a superseded attempt never deletes a newer upload.
2. It deletes the exact original object keys it read. If the delete fails, the job stays
   `processing` and is retried (`TransientJobError storage_delete`). Only the **last** attempt
   falls back to `failed` with `failureCode = too_long`, keeping the sources, as before.
3. One job-guarded transaction deletes the `meeting_upload` row and sets `status = draft`,
   `failureCode = too_long`. The same write clears `stage`, `processingStartedAt`,
   `processingRequestedBy`, `processedAt` and `durationMs`.

A **recorded** source that is too long is unchanged: it ends `failed` with `too_long` and its
chunks are kept. Confirm-time refusals are **not** persisted. These are the 422 `upload_rejected
{reason}`, `too_large` and `unsupported_type` from `POST .../upload/confirm`: the object is
deleted, the meeting stays `draft` and `failureCode` is not touched. The client learns of them
only from the 422 response.

**View contract.** `Meeting.failure` is `{ code: failureCode }` when
`(status = 'failed' || status = 'draft') && failureCode !== null`, otherwise `null`. A client
reads `failure` on a `draft` as "the last file was refused (code), upload another", not as
"processing failed". On a draft the retry action does not apply: AC-6.9 retry still needs
`failed`.

**Notification.** After step 3 commits, the creator gets a best-effort in-app notification of
kind `upload_refused`. The recipient is `processingRequestedBy` read before the flip, falling
back to `creatorUserId`; only the creator uploads, so in practice this is the creator. It is sent
in English and Italian (ADR-0065), and goes through the same `announceProcessing` path as
`transcription_done`/`transcription_failed`. EN copy: "File refused: <title>" / "The file
uploaded for \"<title>\" is longer than 3 hours and was removed. Open the meeting to upload a
shorter file." The refusal path enqueues no host notice.

**Clearing rule.** The next upload mint (`POST .../upload`) clears `failureCode` to `null`. It does
this in the **same transaction** as the `meeting_upload` upsert, and only `WHERE status = 'draft'`.
A meeting that left `draft` in the meantime keeps its own `failureCode`. The confirm flip to
`processing` also writes `null`. No other path clears it, and nothing derives or sweeps it.

**Tests:** `src/jobs/handlers/prepareAudio.refuse.test.ts` (refuse, delete-failure retry and
last-attempt fallback, stale attempt does not delete a newer upload, recorded source still
fails) and `src/capture/upload.test.ts` (mint clears only on a draft, in the transaction).
