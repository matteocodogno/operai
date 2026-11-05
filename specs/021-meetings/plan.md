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
    creator is deactivated.

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
  role: 'creator' | 'participant'; summaryCount: number; creator: PersonRef }
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
| `GET /hosts/:app/:type/:id/linkable-meetings` | capability(`meetings:access`) | `q?`, `page` | `Page<MeetingRow>` of the caller's own meetings as **creator**, not frozen, `host` ≠ this entity (standalone or linked elsewhere), `startsAt` desc (G2). 422 `host_not_registered`; no host call here: the link itself (`PATCH host`) resolves |
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

### Capture

| Route | Stack | Body | Answer |
|---|---|---|---|
| `POST /meetings/:id/recording/start` | creator-control | | 201 `{ sessionId, chunkSeconds: 10, maxChunkBytes: 8388608, next: PresignedPost /* seq 0 */ }`; 409 `consent_required` · `not_draft` · `recording_elsewhere` · `wrong_source` |
| `POST /meetings/:id/recording/chunks/:seq/confirm` | creator-control | `{ sessionId, durationMs ≤ 15000, capturedMs? }` | `{ storedChunks: number, durationMs, next: PresignedPost }`; 409 `session_inactive` · `duration_limit`; 422 `chunk_missing` (HEAD 404) |
| `POST /meetings/:id/recording/chunks/:seq/upload-url` | creator-control | `{ sessionId }` | `PresignedPost` (re-mint after expiry) |
| `POST /meetings/:id/recording/heartbeat` | creator-control | `{ sessionId, paused: boolean, capturedMs: number ≤ 10 800 000 + 60 000 }` | 204 |
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
| `PUT /meetings/:id/transcript/speakers/:key` | creator-control | `{ participantId } \| { text } \| null` (null = back to "Speaker n") |

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
| AC-2.11 | unit + integration | fake timers: warning at 2 h 50, auto-stop + save + `processing` at 3 h; chunk past 3 h + 60 s → 409 `duration_limit`; second `start` while live → 409 `recording_elsewhere` |
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
| AC-6.2 | unit + integration | provider phrases → segments, labels by first appearance, single voice → one label; rename → all segments show the new label |
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
| AC-10.2 | integration | row fields, `startsAt` desc, 25 per page, `q` substring case-insensitive, role/status (incl. derived `interrupted`)/host filters |
| AC-10.3 | integration + component | fake host `open` → "Deal · title" link, `closed`/`unavailable` → "CRM · deal", `missing` → "No longer available" |
| AC-10.4 | integration + e2e | participant without `meetings:access` reads transcript and summaries; every mutation → 403 `meetings_access_required`; no controls; no sidebar entry |
| AC-10.5 | e2e | holder sees Meetings in the sidebar with New meeting and Templates |
| AC-10.6 | integration + component | resolve stub 503 → list, open, transcript, summaries 200 for creator/participant; capability routes 503; banner shown, controls hidden |
| AC-10.7 | component | empty state with and without New meeting |
| AC-10.8 | contract (auth) | seed: `employee` holds `meetings:access`; `template:manage`/`meeting:erase` only on `admin`; no other rule mentions them |
| AC-11.1 | unit | production registry is exactly `crm/deal` with requirement and notices flags; `MEETINGS_TEST_HOSTS` with `NODE_ENV=production` → exit 1 |
| AC-11.2 | integration + e2e | deal list = exactly what the viewer may open, newest first, title/date/status/summaryCount/creator; response has no hidden counts; empty state + Start meeting for holders |
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

