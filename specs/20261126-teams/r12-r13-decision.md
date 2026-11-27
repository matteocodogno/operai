# R12 and R13 of specs/20261126-teams: decision

Date: 2026-11-27. Author: the architect, at the caller's request (follow-up work outside the closed feature's ACs).
Status: draft for the owner. Nothing in the repo was changed.

Read before deciding: `specs/20261126-teams/plan.md` R12, R13, D15, D16 (§ Deadlines); `specs/20261126-teams/eval-report.md`
(the R12 and R13 rows routed to the architect); ADR 20261119-on-demand-outbound-work-… (the nesting rule); ADR
20261126-a-host-says-unknown-… (D16 amendment); ADR 20261126-teams-live-in-auth-… (R12 escalation trigger).

---

## 0. Decisions in one table

| # | Decision | Services touched |
|---|---|---|
| R12 | A repo-level offline check, `scripts/check-single-replica.ts`, refuses a `.railway/railway.ts` that gives projects-api anything but one replica, with a message naming the per-process limiters. It runs as its own job in `railway-drift.yml`, which already runs on every push to `main` that touches `.railway/**`. The four other single-replica services whose reason is already written down are registered too. No startup check. | none deployed (script, workflow, comments) |
| R13 (a) | A host resolve waits at most **500 ms** (`HOST_AUTHZ_WAIT_MS`) for a permission resolve it does not have cached. Past it the request is refused with the existing 503 `authz_unavailable` **inside** the caller's 2 s. The resolve itself is **not aborted**: it becomes single flight per `(sub, perm_epoch)`, keeps its 5 s and fills the 30 s cache, so the retry the 503 asks for succeeds. Page routes keep waiting the whole flight (no deadline above them). Applied to projects-api **and** crm-api, the two hosts of the same routes. | projects-api, crm-api |
| R13 (b) | hours-api waits **6 000 ms** (`RELAYED_OWNER_TIMEOUT_MS`) for an owner that itself asks a host before it answers (activities-api `GET /activities?ids=` / `?dealId=`, meetings-api `GET /meetings?ids=`). Direct host calls keep 2 000 ms. The middles bound their own inner waits so the sum fits: activities-api waits at most **800 ms** for display names (`NAMES_WAIT_MS`, lookup runs on into its 60 s cache); meetings-api's list stops making a permission resolve it never reads and waits at most 800 ms for its creators' names. | hours-api, activities-api, meetings-api |
| ADR | No new ADR. Draft amendments: ADR 20261119-on-demand-outbound-work-… (A1, the rule applied to the host contract, plus "a bounded wait must not abort what fills the cache"), ADR 20261126-a-host-says-unknown-… (A2, its D16 Risks bullet), ADR 20261126-teams-… (A3, R12 guard named). Text in § 9. | docs (adr-writer) |

Security flag: **YES**. Two authorization middlewares change (projects-api, crm-api: a fail-closed path gains a single
flight and a bounded wait) and one meetings route drops its optional permission resolve. Schedule an `owasp-reviewer`
pass on `projects-api/src/auth/authz.middleware.ts`, `crm-api/src/auth/authz.middleware.ts` and
`meetings-api/src/meetings/list.routes.ts` (§ 10).

---

## 1. The chain map, current numbers

Every timeout below was read in the code. "Outer" is the party that gives up; "inner" is what the provider can spend
before it answers. The browser (shell `apiFetch`) sets no timeout, so a browser-initiated route has no outer deadline.

### 1.1 Who calls the host routes, and who waits

| Host route | Caller (outer) and its deadline | What a person waits for |
|---|---|---|
| projects-api `POST /activity-host/v1/resolve` | activities-api `RESOLVE_TIMEOUT_MS = 2_000` (`activities-api/src/hosts/client.ts:31`), sequential calls of 25 ids (`:239-247`) | every CRM / Projects activity and task page, My tasks, a task assignment |
| same | hours-api `OWNER_TIMEOUT_MS = 2_000` (`hours-api/src/clients/owner.ts:31`) | Record hours on a project (bookability, a write), the hours labels (views) |
| projects-api `POST /meeting-host/v1/resolve` | meetings-api `RESOLVE_TIMEOUT_MS = 2_000` (`meetings-api/src/hosts/client.ts:40`), batches of 25 (`:43`, not exported) | a host reader opening a meeting, host labels on meeting lists |
| crm-api `POST /activity-host/v1/resolve` | activities-api 2 000; hours-api 2 000 (deal, `involved`) | CRM timelines and tasks; Record hours on a deal |
| crm-api `POST /meeting-host/v1/resolve` | meetings-api 2 000 | the same as for projects-api |

### 1.2 Inside a host resolve (inner), today

| Step | projects-api | crm-api |
|---|---|---|
| JWT verify | jose remote JWKS, reloads inline once `cacheMaxAge` (10 min, jose 6.2.3 default) has passed, `timeoutDuration` 5 000 (`projects-api/src/auth/jwt.middleware.ts:47`) | same (`crm-api/src/auth/jwt.middleware.ts:47`) |
| permission resolve on a cache miss | `fetchAuthzResolve`, `RESOLVE_TIMEOUT_MS = 5_000` (`projects-api/src/authz/resolveClient.ts:20`), cache 30 s per `(sub, perm_epoch)` (`src/auth/authz.middleware.ts:37`), **no single flight** | identical copy (`crm-api/src/authz/resolveClient.ts:20`, `crm-api/src/auth/authz.middleware.ts:37`) |
| DB | the batch's projects with members and attached teams | deals / companies / contacts |
| team read | `teamReader.cached()`, waits ≤ `TEAMS_HOST_WAIT_MS = 800` (`src/lib/teams.ts:55`), flight 5 000 runs on | none |
| margin D16 assumed | `TEAMS_HOST_MARGIN_MS = 1_000` (`src/lib/teams.ts:61`), described as covering "a permission check (cached 30 s)", i.e. **warm only** | none |

**Violation (R13 a).** Cold permission cache: inner ≤ 5 000 (resolve) + 800 (teams) + work, inside an outer of 2 000.
A slow-but-working auth on the first request of a person in any 30 s makes the host answer after its caller gave up.
crm-api has the identical violation (5 000 inside 2 000) for the same three callers: R13 named only projects-api because
the teams feature was projects-centred.

### 1.3 hours-api → a middle service → a host (R13 b)

| hours-api call | Outer today | Middle's inner today |
|---|---|---|
| activities-api `GET /activities?ids=` (≤ 50 ids, `ACTIVITIES_IDS_BATCH_SIZE = 50`, `hours-api/src/clients/activities.ts:33`); used by `targets/activity.ts:39` (a write) and `labels/resolve.ts:140` (views) | 2 000 | JWT; DB; each owning host asked in parallel (`activities.routes.ts` `listByIds`, `Promise.all` over hosts), but **within one host sequentially in calls of 25** (`hosts/client.ts` `resolve`), so ≤ 50 ids over ≥ 26 projects = **2 rounds × 2 000**; then `toViews` → `loadPeople` → `resolveIdentities`, **5 000 per batch of 100 people, sequential, aborted at 5 s** (`activities-api/src/lib/identities.ts:32`, `src/lib/people.ts:22`) |
| activities-api `GET /activities?dealId=…&page=` (pages of 100, at most 10; `listDealActivities`, used by `targets/bookability.ts:113`, a write) | 2 000 per page | JWT; DB; crm host round 1 for the deal's companies (`activities.routes.ts`, the `dealId` branch), then **round 2** in `toViews` → `loadHostsFor` for the page's related contacts and deal (`view.ts:95-104`): **2 rounds × 2 000**; then names, ≥ 5 000 |
| meetings-api `GET /meetings?ids=` (≤ 25, `MEETINGS_IDS_BATCH_SIZE = 25`, `hours-api/src/clients/meetings.ts:35`); used by `targets/bookability.ts:85` (a write) and `labels/resolve.ts:139` | 2 000 | JWT; then `optionalAuthzMiddleware` (`selfScoped`, `meetings-api/src/meetings/list.routes.ts:70`) which waits up to **5 000** for a permission resolve (`meetings-api/src/authz/resolveClient.ts:20`) whose result **the list never reads** (no `holds(`, `c.get("authz")` or `capabilities` in `list.routes.ts` or `meetings/rows.ts`); then in parallel (`rows.ts:100-107`) DB, the creators' names (**5 000**, `meetings-api/src/lib/identities.ts:51`) and the host labels (`hostViews` → meeting-host resolve, 1 round × **2 000**) |
| meetings-api `GET /system/meetings/hosts` (service JWT) | 2 000 | service JWKS (same 10 min reload), DB. **Fits.** |
| projects-api / crm-api activity-host resolve (direct) | 2 000 | § 1.2 |

**Violation (R13 b).** Inner ≥ outer on every relayed call: 2 × 2 000 + 5 000 on activities-api, 5 000 + 5 000 on
meetings-api, against 2 000. The meetings list is the same "inner = outer" shape as the one R13 named
(hours-api 2 s → middle → host 2 s), found while mapping "every caller of those routes": meetings-api is a caller of
`/meeting-host/v1/resolve`.

### 1.4 Not part of these chains (checked)

- crm-api → activities-api `/system/v1/*` (4 000, `crm-api/src/lib/activities.ts:32`): service JWT, no host resolve and no
  name lookup inside (`activities-api/src/system/` has neither). Not changed.
- hours-api's own `/authz/resolve` (2 000, `hours-api/src/authz/resolveClient.ts:19`) and identities (2 000): browser
  paths only.
- The page path of projects-api and crm-api (`authorized`, `GET /attached-teams`, `fresh()`, `options()`): browser,
  no outer deadline. Unchanged except that concurrent resolves now share one flight.

---

## 2. Decided numbers and the invariants the tests assert

Margins follow the precedent: 1 000 ms where a whole service's work sits inside the margin
(`accounting-api/src/budgets.cross-package.test.ts`, D16), and an itemized split where one slice is now its own wait.

### 2.1 Host path (R13 a)

| Constant | Value | Where (new unless noted) |
|---|---|---|
| `HOST_AUTHZ_WAIT_MS` | 500 | `projects-api/src/lib/hostBudget.ts`, `crm-api/src/lib/hostBudget.ts` |
| `HOST_PATH_REST_MS` | 500 | same two files: JWT verify on a warm key set, the DB query, building the answer, two in-region hops, event-loop delay (normal total well under 100 ms) |
| `RESOLVE_TIMEOUT_MS` | 5 000, unchanged, **now exported** | `projects-api/src/authz/resolveClient.ts:20`, `crm-api/src/authz/resolveClient.ts:20` |
| `TEAMS_HOST_WAIT_MS` / `TEAMS_HOST_MARGIN_MS` | 800 / 1 000, unchanged | `projects-api/src/lib/teams.ts` |

Invariants:

- projects-api: `HOST_AUTHZ_WAIT_MS + TEAMS_HOST_WAIT_MS + HOST_PATH_REST_MS < D` for each consumer `D` = 2 000
  (activities-api, meetings-api, hours-api): **500 + 800 + 500 = 1 800 < 2 000**.
- projects-api: `HOST_AUTHZ_WAIT_MS + HOST_PATH_REST_MS <= TEAMS_HOST_MARGIN_MS` (500 + 500 = 1 000): D16's margin is now
  itemized; D16's own `800 + 1 000 < 2 000` and its pins stay true and untouched.
- crm-api: `HOST_AUTHZ_WAIT_MS + HOST_PATH_REST_MS < D` for the same three `D`: **1 000 < 2 000**.
- both: `HOST_AUTHZ_WAIT_MS < RESOLVE_TIMEOUT_MS` (the flight outlives the wait, so a late answer still fills the cache).

Why 500, not more. A slow auth is paid twice on projects-api's cold path (the D16 reasoning): the resolve, then the team
read. The three waits must sum strictly under 2 000; 500 keeps D16's 800 and gives the rest an honest 500. 500 ms is
10 to 25 times auth's normal `/authz/resolve` time (a few indexed queries, tens of ms), so normal work never meets it
(ADR 20261119's mirror). crm-api gets the same 500: one figure for "a host's wait for a cold permission check", one
reasoning, one escalation trigger; crm-api simply keeps more slack.

### 2.2 Relayed owners (R13 b)

| Constant | Value | Where |
|---|---|---|
| `RELAYED_OWNER_TIMEOUT_MS` | 6 000 (new) | `hours-api/src/clients/owner.ts`, beside `OWNER_TIMEOUT_MS` (2 000, unchanged) |
| `NAMES_WAIT_MS` | 800 (new) | `activities-api/src/lib/people.ts` |
| `LIST_HOST_ROUNDS` | 2 (new, descriptive) | `activities-api/src/hosts/client.ts`: the most sequential resolve calls one list request (`?ids=` ≤ 50, one `?dealId=` page) makes to ONE host; pinned by an activities-api behaviour test |
| `RESOLVE_BATCH_SIZE` | 25, unchanged, already exported | `activities-api/src/hosts/client.ts:33` |
| `LIST_NAMES_WAIT_MS` | 800 (new) | `meetings-api/src/lib/identities.ts` |
| `RESOLVE_BATCH` | 25, unchanged, **now exported** | `meetings-api/src/hosts/client.ts:43` |
| identities `REQUEST_TIMEOUT_MS` | 5 000, unchanged, **now exported** | `activities-api/src/lib/identities.ts:32`, `meetings-api/src/lib/identities.ts:51` |
| `RELAY_MARGIN_MS` | 1 000 (in the test, as the accounting precedent) | `hours-api/src/clients/owners.budgets.cross-package.test.ts` |

Invariants (asserted in hours-api's cross-package test, reading the other packages as text):

- rounds on `?ids=`: `ceil(ACTIVITIES_IDS_BATCH_SIZE / RESOLVE_BATCH_SIZE) = ceil(50 / 25) = 2 <= LIST_HOST_ROUNDS`.
- activities-api: `LIST_HOST_ROUNDS × RESOLVE_TIMEOUT_MS + NAMES_WAIT_MS + RELAY_MARGIN_MS < RELAYED_OWNER_TIMEOUT_MS`:
  **2 × 2 000 + 800 + 1 000 = 5 800 < 6 000**.
- meetings-api: `ceil(MEETINGS_IDS_BATCH_SIZE / RESOLVE_BATCH) = 1`, and
  `max(1 × RESOLVE_TIMEOUT_MS, LIST_NAMES_WAIT_MS) + RELAY_MARGIN_MS < RELAYED_OWNER_TIMEOUT_MS`: **2 000 + 1 000 = 3 000 < 6 000**
  (the names and the host labels run in parallel, `rows.ts:100`).
- both middles: `NAMES_WAIT_MS < REQUEST_TIMEOUT_MS` (5 000): the name lookup outlives the wait and fills the cache.
- `OWNER_TIMEOUT_MS = 2_000` unchanged (pinned by projects-api's and crm-api's tests: hours-api is a direct caller of
  both hosts).

Why one 6 s and not 4 s for `?ids=` and 6 s for the deal scan. Keeping hours-api's batch of 50 means `?ids=` can need two
rounds too, so both activities calls need 5 800; one constant then covers all three relayed calls, and a reader has two
figures for hours-api: 2 s for a host, 6 s for an owner that asks a host. The outer is only reached if the middle
itself stalls (a DB stall, a pause): when a host or auth is slow, the middle answers by its own budgets (≤ 5.8 s
activities, ≤ 3.0 s meetings), and when a middle is down the connection fails at once. Rejected: shrinking hours-api's
`ACTIVITIES_IDS_BATCH_SIZE` to 25 so `?ids=` needs one round. It doubles activities-api calls on a labels page and each
call charges the person's identities budget at auth on a name-cache miss, and the deal scan still needs two rounds.

Why bound the names and not raise the outer further. Without a names wait the activities inner is
2 × 2 000 + 5 000 × (people / 100) + work; the outer would be ≥ 10 s and still grows with the page. Names are fail soft
by design (ADR 20260807-live-identity-resolution-by-id-fail-soft): a bounded wait is the designed degradation, and
hours-api does not read them at all (`hours-api/src/clients/activities.ts` `toFact` keeps ids only).

Why the meetings list loses its permission resolve. It is `selfScoped` (`[jwtMiddleware, optionalAuthzMiddleware]`), so
it waits up to 5 s on `/authz/resolve` and never reads the answer. A JWT-only guard changes no byte of its output, keeps
the outage behaviour ("serves" in `authz-outage.test.ts`) and removes 5 s from the chain and a call to auth per cold
list. Rejected: bounding `optionalAuthzMiddleware` for all 24 `selfScoped` routes. It would withhold capability-gated
controls on a slow-auth load across every meetings screen, which is the meetings owner's posture to decide (ADR
20261104-meetings-tool-shape-visibility-by-participation), and nothing in these chains needs it.

Why the meetings names wait is for the lists only. meetings-api's display lookup also feeds model prompts
(`meetings/promptSegments.ts:18-30`): a shorter wait there would put "unknown" speakers into a summary. Only `rows.ts`
(the lists, the one meetings path inside another service's deadline) passes the wait. activities-api has no prompt
reader, so its rule is global.

### 2.3 The full chain after the change

```
hours-api (person: browser, no deadline)
├─ projects-api activity-host resolve ........ outer 2 000 ⊃ 500 authz + 800 teams + 500 rest = 1 800
├─ crm-api activity-host resolve (deal) ...... outer 2 000 ⊃ 500 authz + 500 rest = 1 000
├─ activities-api ?ids= / ?dealId= ........... outer 6 000 ⊃ 2 rounds × [outer 2 000 ⊃ host path above] + 800 names + 1 000 = 5 800
├─ meetings-api ?ids= (JWT only) ............. outer 6 000 ⊃ max(1 round × [outer 2 000 ⊃ host path], 800 names) + 1 000 = 3 000
└─ meetings-api /system/meetings/hosts ....... outer 2 000 ⊃ DB (unchanged)
activities-api (browser) → host resolve ...... outer 2 000 ⊃ host path above
meetings-api (browser) → meeting-host ........ outer 2 000 ⊃ host path above
```

---

## 3. R12: the guard

### 3.1 What

`scripts/check-single-replica.ts` (new, modelled on `scripts/check-shared-copies.ts`: a registry, a self-test, exit 0 / 1,
offline, no secret):

```ts
export interface SingleReplica { readonly service: string; readonly why: string }

/** Services whose correctness or budget depends on running ONE process. Add one when that becomes true. */
export const SINGLE_REPLICA: readonly SingleReplica[] = [
  { service: "projects-api", why: "its team-read limiters are per process (specs/20261126-teams D13, D15, R12): a second replica doubles TEAM_READ_SERVICE_LIMIT (2 400 / 10 min) past auth's `teams` allowance (3 000). First divide the figures in projects-api/src/lib/rateLimiter.ts by the replica count or move the windows to a shared store (ADR 20261126-teams-… escalation trigger)" },
  { service: "notify-api", why: "the SSE fan-out and the stream-ticket store are in process (ADR 20260713-sse-stream-auth-short-lived-ticket; notify-api/src/notifications/eventBus.ts, ticketStore.ts)" },
  { service: "meetings-api", why: "the in-process job runner (ADR 20261104-durable-job-runner-work-queued-state-derived; AGENTS.md 'single replica')" },
  { service: "letterhead-api", why: "the render pool, its queue and the per-caller share are in process (ADR 20261116-renders-run-in-killable-worker-processes-…; .railway/railway.ts comment)" },
  { service: "accounting-api", why: "the rate fetch is single flight per (entity, month) in process; a second replica doubles the calls to the federal source (.railway/railway.ts comment)" },
];
```

The four lines after projects-api record reasons the repo already states in comments; nothing new is decided. If the
caller wants R12 strictly, keep only projects-api (the checker is unchanged).

Parsing: read `.railway/railway.ts` as text (a missing file is a failure, never a skip). Drop `//` line comments
(`/(^|\s)\/\/.*$/gm`; the file has no `//` inside a string in a service block). For each registered service: exactly one
`service("<name>",`; inside its call (up to the next `service(`, `bucket(`, `volume(`, `postgres(` or `return project(`)
exactly one `replicas: { … }`; each entry must match `"<region>": <integer>`; the sum must be 1. Anything else (absent,
repeated, a non-literal such as `replicas: REPLICAS`, a sum of 2 over two regions) fails with:

```
projects-api: .railway/railway.ts must give it exactly 1 replica (found 2).
  Why: <why>
  To run more, make the change the reason names first, then remove its entry from SINGLE_REPLICA
  in scripts/check-single-replica.ts in the same commit.
```

Where it runs: a new job `single-replica` in `.github/workflows/railway-drift.yml`, offline (`oven-sh/setup-bun@v2`,
`bun test scripts/check-single-replica.test.ts` then `bun scripts/check-single-replica.ts`), independent of the
`RAILWAY_TOKEN` step so it runs without the secret. The workflow already triggers on every push to `main` under
`.railway/**` (the owner commits straight to `main`, so a `pull_request` trigger would not fire), on weekdays and by hand;
add `scripts/check-single-replica*.ts` to its push paths. Optional: a `mise run replicas:check` task, as `shared:check`.

Comments, the precedent's own form:

- `.railway/railway.ts`, above `const projectsApi`: `// - Single replica: the team-read limiters (specs/20261126-teams D13, D15) are in process, so a second replica doubles them past auth's teams allowance (R12). scripts/check-single-replica.ts refuses another figure.` (A comment only: `railway config plan` is unchanged.)
- `projects-api/src/lib/rateLimiter.ts:11-13`: "projects-api runs one replica (R12)" gains "; `scripts/check-single-replica.ts` refuses another figure in `.railway/railway.ts`".

Together with `railway-drift.yml`'s existing plan (live Railway vs the file), a replica change by commit fails at once,
and a change in the dashboard shows as drift.

### 3.2 Rejected

- **A startup check.** A process on Railway learns its own replica (`RAILWAY_REPLICA_ID`, `RAILWAY_REPLICA_REGION`), never
  the count. A Postgres advisory-lock singleton would collide with Railway's deploy overlap (the new instance is
  health-checked while the old one still runs), so every deploy would fail or need a wait loop; and the risk is a doubled
  limit, not corrupted data. notify-api and meetings-api, the precedents, have none.
- **A projects-api unit test reading `.railway/railway.ts`.** It runs when someone tests projects-api, not when someone
  edits the Railway file; the drift workflow runs at the edit.
- **Moving the windows to a shared store now.** That is the remedy for the day a second replica is wanted (the
  `RateLimiter` seam, ADR escalation trigger), not a guard; it costs a DB write per page read today.
- **Asserting `replicas × TEAM_READ_SERVICE_LIMIT < auth's allowance`.** auth's `teams` allowance is a runtime figure in
  auth, not a literal projects-api can read; "exactly 1, and here is why" is the mechanical form of R12's mitigation.

---

## 4. R13 (a): the host path's permission wait

### 4.1 Behaviour

`authzMiddleware` gains a single flight per `(sub, perm_epoch)` and a host variant:

- **Cache hit** (entry younger than 30 s): unchanged.
- **Miss**: join the key's flight or start one. A flight calls `fetchAuthzResolve` with the joining caller's own,
  already-verified header (as today), stamps `sentAt` before the call, and on success stores
  `{ context, expiresAt: sentAt + 30 s }` (as today: the TTL counts from the send). On failure it stores nothing.
- **Page routes** (`authorized`, every guard that uses `authzMiddleware` today): wait for the flight (≤ 5 s), as today.
- **Host routes** (`hostAuthzMiddleware`): wait at most `HOST_AUTHZ_WAIT_MS` (500). A flight still running then is
  answered with the existing 503 `authz_unavailable` (projects-api; crm-api's body has no `code` today and keeps none:
  not folded into this change), logged as `[authz] auth GET /authz/resolve not answered within the host wait: denying (fail-closed) reason=wait_exceeded`
  (no sub, no token, as the existing line). The flight is **not aborted**: it runs to its own 5 s and its answer fills
  the cache. A request that arrives while it runs joins it with a full wait of its own.
- **Fail closed, unchanged**: a failed flight is a 503 for every waiter, nothing cached, no expired entry ever served.

Why single flight: without it a run-on resolve multiplies under exactly the condition it exists for (a slow auth and a
person whose pages fire several host resolves at once). With it, page and host requests of one person share one call.
This is the same semantics the cache already has: an answer is shared by every request of the same `(sub, perm_epoch)`.

### 4.2 What a slow auth then yields

auth answering `/authz/resolve` in X, the person's permission cache cold:

| X | today | after |
|---|---|---|
| < 0.5 s | answered | answered |
| 0.5 to ~1.1 s | answered, using most of the 2 s, sometimes timed out | 503 at 0.5 s; the flight fills the cache at X; the retry the 503 asks for succeeds |
| ~1.1 to 5 s | the caller times out at 2 s; projects-api carries on, runs the DB query and possibly a team flight for nobody | 503 at 0.5 s, inside the deadline; no DB query or team read is run for a request nobody reads; cache filled at X; retry succeeds |
| > 5 s or failing | 503 / timeout | 503 at 0.5 s; nothing cached (fail closed) |

The 0.5 to 1.1 s band is the honest cost: a person gets a fast "try again" where today they often got a slow answer.
Accepted, because the alternative that keeps that band (one deadline counted from the request's arrival, the team wait
taking what the resolve left) re-opens D16's rejected "per-call wait on `cached()`" and "counted from the arrival", and
because that band means auth is 10 to 25 times slower than normal. Escalation trigger (in A1): `reason=wait_exceeded`
on the host wait while auth's `/authz/resolve` p95 stays under 250 ms.

### 4.3 Rejected

- **One shorter `RESOLVE_TIMEOUT_MS` for all routes.** It aborts the flight: under a slow auth no permission would ever be
  cached, so every host and page request would fail for as long as auth stays slow (the "working provider judged dead"
  shape D16 rejected for the team read); and the page path has no deadline that asks for it.
- **A per-request deadline counted from arrival, shared by the resolve and the team wait.** Better in the 0.5 to 1.1 s
  band, at the price of a request-start hook and a wait parameter on `cached()` that D16 rejected; reconsider only under
  the escalation trigger.
- **Raising the consumers' 2 s.** Three services and a suite-wide host contract (D16 already rejected it); every page
  that resolves would wait longer.
- **Leaving crm-api out.** It is the other host of the same routes, the same 5 s inside the same 2 s callers, and the
  same copied middleware (`diff` shows one line apart). Leaving it would keep the defect the ADR names, two timeouts in
  two places with no test relating them, for half of every My tasks page.

---

## 5. Exact code changes, per file

### R12

| File | Change |
|---|---|
| `scripts/check-single-replica.ts` (new) | registry, parser, report, exit 0/1 (§ 3.1) |
| `scripts/check-single-replica.test.ts` (new) | § 6.1 |
| `.github/workflows/railway-drift.yml` | new offline job `single-replica`; add `scripts/check-single-replica*.ts` to `push.paths` |
| `.railway/railway.ts` | comment above `const projectsApi` only (no configuration change) |
| `projects-api/src/lib/rateLimiter.ts` | header comment names the checker |
| `mise.toml` (optional) | `replicas:check` task |

### R13 (a): projects-api

| File | Change |
|---|---|
| `projects-api/src/lib/hostBudget.ts` (new, no imports) | `export const HOST_AUTHZ_WAIT_MS = 500;` and `export const HOST_PATH_REST_MS = 500;`, each documented with what it covers and the invariant, pointing at the cross-package test |
| `projects-api/src/authz/resolveClient.ts` | `const RESOLVE_TIMEOUT_MS` → `export const RESOLVE_TIMEOUT_MS = 5_000;` (no behaviour change) |
| `projects-api/src/auth/authz.middleware.ts` | module-scope `inflight: Map<string, Promise<AuthzContext \| null>>`; a `flight(key, header)` that starts or joins (stamping `sentAt`, storing on success, never on failure, `finally` deleting the map entry); `createAuthzMiddleware(waitMs: number \| null)` racing the flight against one timer cleared in `finally` (the `teams.ts:430-441` pattern); `export const authzMiddleware = createAuthzMiddleware(null)` (behaviour as today); `export const hostAuthzMiddleware = createAuthzMiddleware(HOST_AUTHZ_WAIT_MS)`; `__resetAuthzCacheForTests` also clears `inflight`; header comment rewritten (page vs host). Export `createAuthzMiddleware` for tests only (`/** @internal tests */`) |
| `projects-api/src/activity-host/activity-host.routes.ts` | import `hostAuthzMiddleware`; `middleware: [jwtMiddleware, hostAuthzMiddleware]` (line 75); header comment: the host waits 500 ms for a cold permission check |
| `projects-api/src/meeting-host/meeting-host.routes.ts` | same at line 64 |
| `projects-api/src/lib/teams.ts` | doc of `TEAMS_HOST_MARGIN_MS` (lines 56-61): "a permission check (cached 30 s)" becomes "a permission check (cached 30 s, or at most `HOST_AUTHZ_WAIT_MS` when not) and the rest (`HOST_PATH_REST_MS`)"; no value changes |

### R13 (a): crm-api

| File | Change |
|---|---|
| `crm-api/src/lib/hostBudget.ts` (new) | same two constants, same values |
| `crm-api/src/authz/resolveClient.ts` | export `RESOLVE_TIMEOUT_MS` |
| `crm-api/src/auth/authz.middleware.ts` | the same change as projects-api's (single flight, `createAuthzMiddleware`, `hostAuthzMiddleware`); its 503 body unchanged |
| `crm-api/src/activity-host/resolve.routes.ts:109` | `const hostCaller = [jwtMiddleware, hostAuthzMiddleware]` |
| `crm-api/src/meeting-host/resolve.routes.ts:53` | same |
| `scripts/check-shared-copies.ts` (recommended) | register the flight-and-wait region of the two middlewares as a group `authzFlight` (markers `// shared-copy:begin|end authzFlight` in both), so a fix to one reaches the other; add both paths to `shared-copies.yml` |

### R13 (b): hours-api

| File | Change |
|---|---|
| `hours-api/src/clients/owner.ts` | `export const RELAYED_OWNER_TIMEOUT_MS = 6_000;` documented: "an owner that asks a host before it answers (activities-api, the meetings list): its inner rounds plus a margin; pinned by `owners.budgets.cross-package.test.ts`". Header comment line "2 s timeout (plan R2)" becomes "2 s for a host, 6 s for a relayed owner" |
| `hours-api/src/clients/activities.ts` | both `callOwner` calls: `timeoutMs: options.timeoutMs ?? RELAYED_OWNER_TIMEOUT_MS` (replacing the conditional spread at lines 98 and 125) |
| `hours-api/src/clients/meetings.ts` | `listMeetingsByIds` (line 67) the same; `callAsService` (`/system/meetings/hosts`) unchanged at 2 s |

### R13 (b): activities-api

| File | Change |
|---|---|
| `activities-api/src/lib/identities.ts` | export `REQUEST_TIMEOUT_MS`; `ResolveOptions` gains `waitMs?: number`. With `waitMs`: the cached and `system:` answers are put in `result` synchronously, the batch loop runs as a detached promise writing into the cache (and into its own map), the call awaits the loop or the timer (cleared in `finally`), and returns a **snapshot** `new Map(result)` in which every id not yet answered is `unknown` (and not cached). The loop never rejects (it already catches per batch) and keeps its 5 s per batch. Without `waitMs` behaviour is unchanged (`notify.ts:227` keeps its 2 s abort) |
| `activities-api/src/lib/people.ts` | `export const NAMES_WAIT_MS = 800;` `loadPeople` passes `{ waitMs: NAMES_WAIT_MS }` |
| `activities-api/src/hosts/client.ts` | `export const LIST_HOST_ROUNDS = 2;` documented as the most sequential calls one list request makes to one host (`?ids=` ≤ 50: `ceil(50/25)`; one `?dealId=` page: companies, then related), pinned by `activities/hostRounds.test.ts` |

### R13 (b): meetings-api

| File | Change |
|---|---|
| `meetings-api/src/auth/guards.ts` | `export const jwtOnly: MiddlewareHandler[] = [jwtMiddleware];` documented: "a self-scoped read that reads no capability (the meeting list); never on a route that renders a control or admits a host reader" |
| `meetings-api/src/meetings/list.routes.ts` | `middleware: jwtOnly` (line 70); router typed with `JwtVariables`; header comment line 4 keeps "works while auth is down" and adds "makes no permission call" |
| `meetings-api/src/lib/identities.ts` | export `REQUEST_TIMEOUT_MS`; `resolveIdentities(header, ids, options?: { waitMs?: number })` with the same snapshot semantics as activities-api's; `export const LIST_NAMES_WAIT_MS = 800;` |
| `meetings-api/src/meetings/rows.ts` | the creators' lookup (line 105) passes `{ waitMs: LIST_NAMES_WAIT_MS }`; the `deps.resolveIdentities` type follows |
| `meetings-api/src/hosts/client.ts` | `const RESOLVE_BATCH` → `export const RESOLVE_BATCH = 25;` (no behaviour change) |
| `meetings-api/src/test-support/matrixKit.ts`, `auth/guards.test.ts` | the `GET /meetings` row keeps `outage: "serves"`; `guards.test.ts` gains `jwtOnly` (no resolve call) |

No wire contract, env variable, migration or `tools/env-doctor` entry changes. Changesets: one patch changeset selecting
`@operai/projects-api`, `@operai/crm-api`, `@operai/activities-api`, `@operai/meetings-api` and `@operai/hours-api`.

---

## 6. Tests

All cross-package tests follow `projects-api/src/lib/teams.budgets.cross-package.test.ts`: the other package's file is
read as text, exactly one `export const NAME = <n | n * n>;` is accepted, and a missing file or declaration FAILS,
never skips. The `deadlineOf` reader is then copied in four test files (recommended: register it in
`scripts/check-shared-copies.ts` as `deadlineReader`).

### 6.1 R12: `scripts/check-single-replica.test.ts`

- the committed `.railway/railway.ts` passes;
- planted sources, each refused with the service named: `replicas: { "europe-west4-drams3a": 2 }`; two regions of 1;
  `replicas` absent; `replicas` only in a comment; `replicas: REPLICAS`; the service absent; the service declared twice;
- a service not in the registry may have any figure;
- the file missing → exit 1 with a message (never a pass).

### 6.2 R13 (a): projects-api

- **`src/lib/teams.budgets.cross-package.test.ts`** (extended; existing assertions unchanged):
  - pins `HOST_AUTHZ_WAIT_MS = 500`, `HOST_PATH_REST_MS = 500`, `RESOLVE_TIMEOUT_MS = 5_000`;
  - `HOST_AUTHZ_WAIT_MS + HOST_PATH_REST_MS <= TEAMS_HOST_MARGIN_MS`;
  - for each of the three consumer constants already read: `HOST_AUTHZ_WAIT_MS + TEAMS_HOST_WAIT_MS + HOST_PATH_REST_MS < deadline`;
  - `HOST_AUTHZ_WAIT_MS < RESOLVE_TIMEOUT_MS`;
  - static: both host route files contain `middleware: [jwtMiddleware, hostAuthzMiddleware]` and no
    `[jwtMiddleware, authzMiddleware]`; a planted source proves each check can fail (as the existing `cached(` check).
- **`src/auth/authz.middleware.test.ts`** (new; `mock.module` on `../authz/resolveClient`, the module's existing seam;
  behaviour with `createAuthzMiddleware(50)` so the suite stays fast, plus one real-figure test):
  - host variant, resolve held: 503 `authz_unavailable` after the wait, before the resolve answers; with the real
    `hostAuthzMiddleware`, the 503 arrives in [500, 700) ms;
  - the held resolve then answers: the next host request (within 30 s of the SEND) is served from the cache with no new
    resolve call;
  - three concurrent requests of one `(sub, perm_epoch)`, two host and one page: ONE resolve call; the page request gets
    200 when the resolve answers after the host wait;
  - a failed resolve: every waiter 503, nothing cached, the next request starts a new flight;
  - an answer arriving 4 s after its send is usable until send + 30 s, not answer + 30 s;
  - an expired entry is never served while a refresh is slow (fail closed);
  - the page variant waits the whole flight (a 2 s answer → 200).
- **`src/activity-host/activity-host.test.ts`, `src/meeting-host/meeting-host.test.ts`** (extended): auth stub holding
  `/authz/resolve` 3 s, cold cache → each resolve answers 503 within `HOST_AUTHZ_WAIT_MS + HOST_PATH_REST_MS`; after the
  stub answers, the same resolve is answered normally; the D16 slow-team tests stay green (warm permission).

### 6.3 R13 (a): crm-api

- **`crm-api/src/lib/hostBudget.cross-package.test.ts`** (new): reads activities-api `RESOLVE_TIMEOUT_MS`, meetings-api
  `RESOLVE_TIMEOUT_MS`, hours-api `OWNER_TIMEOUT_MS` (each 2 000); asserts `HOST_AUTHZ_WAIT_MS + HOST_PATH_REST_MS < deadline`
  and `HOST_AUTHZ_WAIT_MS < RESOLVE_TIMEOUT_MS`; static: both `hostCaller` declarations are
  `[jwtMiddleware, hostAuthzMiddleware]`, with planted failures.
- **`crm-api/src/auth/authz.middleware.test.ts`** (new): the projects-api cases.

### 6.4 R13 (b)

- **`hours-api/src/clients/owners.budgets.cross-package.test.ts`** (new): reads activities-api
  `src/hosts/client.ts` (`RESOLVE_TIMEOUT_MS`, `RESOLVE_BATCH_SIZE`, `LIST_HOST_ROUNDS`), `src/lib/people.ts`
  (`NAMES_WAIT_MS`), `src/lib/identities.ts` (`REQUEST_TIMEOUT_MS`), and meetings-api `src/hosts/client.ts`
  (`RESOLVE_TIMEOUT_MS`, `RESOLVE_BATCH`), `src/lib/identities.ts` (`LIST_NAMES_WAIT_MS`, `REQUEST_TIMEOUT_MS`); imports
  hours-api's `RELAYED_OWNER_TIMEOUT_MS`, `OWNER_TIMEOUT_MS`, `ACTIVITIES_IDS_BATCH_SIZE`, `MEETINGS_IDS_BATCH_SIZE`.
  Asserts every inequality of § 2.2 and pins 6 000 / 2 000. Static: `clients/activities.ts` has two
  `?? RELAYED_OWNER_TIMEOUT_MS`; `clients/meetings.ts` has one, in `listMeetingsByIds`, and `callAsService` none.
  Planted-source checks for the reader and the static rules.
- **`hours-api/src/clients/activities.test.ts`, `meetings.test.ts`** (extended): an owner answering after 2.5 s is an
  answer, not `unavailable` (proves the default is no longer 2 s; one real-time test each); the existing override tests
  stay.
- **`activities-api/src/lib/people.test.ts`** (new) or `identities.test.ts` (extended): identities stub held 1.5 s →
  `loadPeople` returns in ≈ 0.8 s with `status: "unknown"` for the uncached ids and the cached ones named; after the stub
  answers, a second `loadPeople` within 60 s names them with no call; a failing lookup caches nothing (unchanged); the
  returned map does not change after it is returned (snapshot).
- **`activities-api/src/activities/hostRounds.test.ts`** (new; counting calls on the fake host): `?ids=` with 50 ids
  over 50 projects → exactly 2 projects-host calls, CRM in parallel; `?ids=` with 25 → 1; one `?dealId=` page → exactly
  2 crm-host calls; no list request makes more than `LIST_HOST_ROUNDS` sequential calls to one host. This is what ties
  the descriptive constant to the code: adding a third round fails here, and raising the constant fails hours-api's
  cross-package test until its outer moves.
- **`meetings-api`**: `meetings/list.test.ts` (extended): `GET /meetings` makes no `/authz/resolve` call (the kit's auth
  stub counts), and with `/authz/resolve` hanging answers normally; with identities held 3 s, `GET /meetings?ids=`
  answers in < 1.5 s with the creator `status: "unknown"`, and the next call within 60 s names the creator without a
  call. `authz-outage.test.ts`: `GET /meetings` still "serves" (unchanged list). Static (in `list.test.ts`):
  `list.routes.ts` and `rows.ts` contain no `holds(`, `c.get("authz")` or `capabilities`, so a future control on the
  list must move it back to `selfScoped`. `lib/identities.test.ts`: the snapshot semantics; without `waitMs` unchanged
  (`promptSegments` and `view.ts` keep the full wait).

---

## 7. What a person sees

- **Normal days: nothing.** Every wait added is 10 to 25 times the normal answer time.
- **auth slow, host path, cold permission cache** (§ 4.2): "could not confirm your access, try again" arrives in about
  0.5 s instead of 2 s, and the retry a moment later works; in the 0.5 to 1.1 s band a request that today often
  succeeded slowly now asks for a retry (accepted trade-off).
- **auth slow, activities lists (CRM and Projects timelines, task lists, My tasks):** the page no longer waits up to 5 s
  per hundred names; after 0.8 s the names not yet known show as unknown (the existing fail-soft display) and the next
  load names them.
- **auth slow, meeting lists:** the creator's name may show as unknown on that load; the meeting page and summaries are
  unchanged. The list also no longer waits on `/authz/resolve` at all.
- **Record hours, hours labels:** when a project, a deal's company or auth is slow, a booking with an activity or on a
  meeting that today was refused at 2 s ("try again") now succeeds, in up to about 5.8 s (activities) or 3 s (meetings).
  Only a stalled activities-api or meetings-api makes a person wait the full 6 s before the 503 (today 2 s). A deal
  scan of a deal with more than 100 activities can, with every page meeting a slow host, take up to pages × 5.8 s (today
  it failed at the first slow page); R9's 10-page bound holds. Named, accepted.
- **Page routes of projects-api and crm-api:** unchanged, except that concurrent requests of one person share one
  `/authz/resolve` call.

---

## 8. Rollout

Every change either shortens an inner wait or lengthens an outer one, and none changes a wire contract (the meetings
list's response is byte-identical, the 503s are the existing codes). Shortening an inner or lengthening an outer can never
break an inequality that holds, so **no deploy order is unsafe**, and the whole change can ship in one push (one push
redeploys every touched Railway service in no fixed order, ADR 20261013 note).

Preferred order if split: hosts first (projects-api, crm-api), then the middles (activities-api, meetings-api), then
hours-api: inner before outer, so at each step every outer is at least as large as it needs to be for what is already
live. In the interim with hours-api first, hours-api only waits longer for answers that today it abandons.

R12 needs no deploy: the checker and the workflow job act on the next push to `.railway/**`. The `.railway/railway.ts`
comment changes no plan (`railway config plan` stays clean).

After deploy, watch for two log lines: `[authz] … reason=wait_exceeded` (projects-api, crm-api) and `[owners] activities
… reason=timeout` (hours-api). Either one under a normal auth is the escalation trigger of A1.

---

## 9. ADR: amendments, no new record

Why no new ADR: the rule is ADR 20261119's ("each inner deadline fits inside the outer minus a margin, a test relates
the constants"); its escalation trigger names this case ("a second provider … is built: apply the nesting rule").
20261119 itself argued that the rule should live in one record found by whoever builds the next provider, not in a
per-case ADR. What this change adds is two refinements of the same failure shape: chains through a middle count
sequential rounds, and a bounded wait must not abort what fills the cache. Both belong in 20261119. The `adr-writer`
applies the text; the architect does not edit ADRs.

### A1: amend ADR 20261119-on-demand-outbound-work-… (append to Decision, Escalation triggers and Evidence)

> *Amended 2026-11-27 (specs/20261126-teams R13, follow-up decision): the rule applied to the host contract, its second
> provider with a consumer deadline.*
>
> 5. **A host's own waits on auth sum under its callers' deadline.** A host resolve (projects-api, crm-api) waits at most
>    `HOST_AUTHZ_WAIT_MS` (500 ms) for a permission resolve it has not cached, and refuses with 503 `authz_unavailable`
>    when it is late. With projects-api's team wait (800 ms) and 500 ms for the rest of the route (`HOST_PATH_REST_MS`),
>    its host path is 1 800 ms inside the 2 s of activities-api, meetings-api and hours-api; crm-api's is 1 000 ms. The
>    page routes, which no deadline bounds, keep waiting the whole resolve.
> 6. **A bounded wait does not abort what fills a cache.** The permission resolve is single flight per
>    `(sub, perm_epoch)`, keeps its own 5 s and stores its answer, stamped when sent, for the next request; display-name
>    lookups on paths inside a deadline wait at most 800 ms and run on into their 60 s cache. An aborted flight never
>    renews the cache, so a provider that is slow but working is judged dead on every later call: this ADR's failure
>    shape, repeated for as long as the provider stays slow.
> 7. **A chain through a middle counts its sequential rounds.** A consumer that asks a service which itself asks a host
>    waits for that service's whole budget: hours-api waits `RELAYED_OWNER_TIMEOUT_MS` (6 s) for activities-api
>    (`LIST_HOST_ROUNDS` 2 × 2 s + 800 ms names + 1 s) and for the meetings list (2 s ∥ 800 ms + 1 s), and 2 s for a host.
>    A lookup on that path whose answer is never read is removed rather than bounded (the meetings list's permission
>    resolve).
>
> The constants are related by `projects-api/src/lib/teams.budgets.cross-package.test.ts`,
> `crm-api/src/lib/hostBudget.cross-package.test.ts` and `hours-api/src/clients/owners.budgets.cross-package.test.ts`;
> `activities-api/src/activities/hostRounds.test.ts` pins the round count.
>
> **Accepted cost:** when auth answers `/authz/resolve` in 0.5 to about 1.1 s on a cold permission cache, a host answers
> "try again" where it used to answer late; the retry succeeds once the resolve has filled the cache.
>
> **Named, not covered:** the JWT key set of every resource server is reloaded inline once 10 minutes have passed
> (jose `cacheMaxAge`), with a 5 s timeout, so one request per process per 10 minutes can still outlast a 2 s caller
> when auth is slow (and a failed reload is a 401). Fixing it trades key-revocation latency against availability, a
> decision for auth's owner.
>
> Further escalation triggers: `reason=wait_exceeded` on a host's permission wait while auth's `/authz/resolve` p95 is
> under 250 ms (consider one deadline counted from the request's arrival, shared by the resolve and the team wait); a
> list route of a middle service gaining a third sequential host round; any change to a host-contract deadline (2 s) or
> to `RELAYED_OWNER_TIMEOUT_MS`, which moves with it in the same change.

### A2: amend ADR 20261126-a-host-says-unknown-… (its Risks bullet "A team read that is slow rather than failed")

Replace the bullet's last sentence ("Only a resolve slowed by something other than the team read (a cold permission
check against a slow auth) can still make the whole call unavailable.") with:

> *Amended 2026-11-27:* a cold permission check against a slow auth is bounded too: the host waits at most 500 ms for
> it, then answers 503 inside the deadline, and the resolve, not aborted, fills the permission cache for the retry
> (ADR 20261119-on-demand-outbound-work-…, amendment 2026-11-27). The whole call is unavailable only when the caller's
> permissions cannot be known in time, which is the fail-closed answer, never a guess.

Evidence gains `projects-api/src/auth/authz.middleware.test.ts` and the extended host tests.

### A3: amend ADR 20261126-teams-live-in-auth-… (Consequences "Every limit is per process (R12)" and the escalation trigger)

Append to the consequence:

> *Amended 2026-11-27:* the single replica is checked mechanically: `scripts/check-single-replica.ts`, run by
> `railway-drift.yml` on every push that touches `.railway/`, refuses a `.railway/railway.ts` that gives projects-api
> any other figure, naming these limiters; raising it means making the change this trigger names and removing the entry
> in the same commit.

### Not amended

ADR 20261110-activities-service-access-delegated-to-host ("2 s, never cached"): unchanged; the host answer is still
never cached by the consumer, and the permission cache is the host's own, as before. ADR 20261104-meetings-tool-shape-…:
unchanged; its `selfScoped` posture holds for every route that keeps it, and the list stays readable without auth.

---

## 10. Security

Sensitive: YES (authorization middleware on a fail-closed path; a route's guard changes).

Surfaces for the `owasp-reviewer`:

1. `projects-api/src/auth/authz.middleware.ts` and `crm-api/src/auth/authz.middleware.ts`: the single flight must key on
   the verified `(sub, perm_epoch)` only (as the cache does), use a verified header, never store a failed answer, never
   serve an expired entry, and answer the wait's expiry with 503, never `next()`. Concern to check: a flight started with
   person A's header serves only requests of the same `sub` and epoch, which is the existing cache semantics.
2. The run-on resolve and the run-on name lookups spend nothing more at auth than today (same calls, fewer with the single
   flight); confirm no amplification path (a held flight is one call per key, removed on settle).
3. `meetings-api/src/meetings/list.routes.ts` on `jwtOnly`: confirm the list reads no capability and admits no host
   reader (its rows are the caller's created or participated meetings, `roleOf`), so dropping the resolve widens
   nothing; the static test in § 6.4 keeps it so.

Regulated data: none new; no escalation to the frontier tier needed.

---

## 11. Residuals after this change

| Id | What | Why not here |
|---|---|---|
| R13-band | the 0.5 to 1.1 s cold-permission band answers "try again" (§ 4.2) | the alternative re-opens D16; trigger in A1 |
| R14 (new) | the JWKS inline reload (5 s every 10 min per process) in every resource server, inside every 2 s caller; a failed reload is a 401, which on a page path sends the shell's refresh-retry-redirect | suite-wide, and fixing it (no inline reload, or `cacheMaxAge: Infinity` relying on unknown-`kid` reloads) trades key-revocation latency; owner: auth/platform. Also: the comment at `*/src/auth/jwt.middleware.ts:44-46` claims jose honours `Cache-Control: max-age=3600`; jose 6 does not (it uses `cacheMaxAge`, 10 min) |
| D16 first read | with auth slower than 0.8 s, a team nobody read for 60 s is unavailable for the first decision on it | by design (D16): the flight fills the cache, the retry succeeds; not a nesting |
| deal scan | a scan of several pages can take pages × 5.8 s when every page meets a slow host (§ 7) | realistic deals are one page; R9 bounds pages at 10 |
| other `selfScoped` meetings routes | still wait up to 5 s on an optional resolve when auth is slow | browser only, no deadline above them; the meetings owner's posture |

Optional follow-up for the caller: a one-line note under `specs/20261126-teams/plan.md` R12 and R13 ("Closed
2026-11-27 by <commit>, see the ADR amendments") once implemented. The plan is approved and done, so that edit is the
caller's call.

---

## 12. Self-critique (one pass; the plan.md checklist does not fit this artifact, applied where it does)

- Idealized codebase: every number and line above was read in the code; the meetings list's unused resolve and the
  activities-api second round on `?dealId=` were found by reading, not assumed. Fixed during the pass: an earlier draft
  shrank hours-api's batch to 25 to get one round on `?ids=`; dropped, because `?dealId=` needs two rounds anyway and the
  smaller batch doubled identity lookups charged to the person.
- Prose contracts: the changes are constants and middleware behaviour, given as names, values and inequalities, each with
  a test that fails when one moves.
- Reflex security NO: flagged YES, with surfaces.
- Kept deliberately: crm-api and meetings-api are in scope although R13 named neither, because they are on the same
  chains ("every caller of those routes"); each is separable (drop § 4 crm-api rows, or § 2.2 meetings rows, and the
  matching test assertions) if the owner wants R13 to the letter.
