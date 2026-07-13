---
spec: 005
status: approved
---

# Plan: Notification center

## Architecture

Two new deployables plus a thin seam added to existing shell code. Nothing about the
notification domain lives inside the shell beyond transport glue; the center page and all
persistence/business logic live in the new service + remote (spec Constraint 4).

### New components

- **`notify-api`** — a new Bun + Hono + Prisma resource server, structurally a clone of
  `estimai-api` (env-validate-at-startup `src/lib/env.ts`, Prisma via `src/lib/db.ts`,
  RFC 7807 Problem JSON via global `app.onError`/`app.notFound`, `@hono/zod-openapi` +
  Scalar, `jwtMiddleware` copied from `estimai-api/src/auth/jwt.middleware.ts` per
  ADR-0005). It owns notification persistence, the raise/list/mark-read endpoints, the
  stream-ticket mint, and the SSE stream. **Local port `8081`** (auth `3001`, estimai-api
  `8080`). **New logical database `notify`** on the shared Postgres (`localhost:5435`),
  split exactly like `estimai` is from the auth DB. Deployed to **Railway EU
  (`europe-west4`)** with its own `railway.json` + Dockerfile mirroring estimai-api
  (data-residency: notification bodies may name clients/estimates → EU-only, never logged;
  reuse estimai-api's method+path+status-only `hono/logger` posture).

- **`notify-ui`** — a new federated remote, structurally a clone of `admin-ui`
  (`@module-federation/vite`, exposes `./App`, consumes `shell/session` +
  `shell/tokens.css`, no own auth guard/chrome, inner TanStack Router with
  `basepath '/notify'`, `src/main.tsx` standalone bootstrap for dev/test). It owns the
  **notification-center page**: the list, per-item detail, ordering, empty state, the
  "was-unread" affordance, the link/action follow, and the explicit "mark all read"
  control. **Local port `5176`** (the slot `admin-ui/vite.config.ts` deliberately left
  free). Deployed as its own Vercel project.

### Shell changes (the ONLY shell-side surface — Constraint 4)

The shell contributes the bell button and the raise-capability seam; everything the bell
needs to be *live* (an always-open SSE connection, the unread count, the transient toast
host) is necessarily shell-side because it must work in ~2s regardless of which remote is
mounted (US-1, US-5) — `notify-ui` is only mounted on the `/notify` route. The shell holds
no notification *business* logic: it renders exactly what `notify-api` decides (the toast
flag rides the pushed event; severity/link are backend data). Additions:

1. **`shell/src/components/Bell.tsx`** — icon button placed in `Header.tsx` beside
   `ThemeToggle`. Reads `useUnreadCount()`; renders the "9+"-capped badge (AC-1.6);
   `onClick` navigates to `/notify` (AC-2.1).
2. **`shell/src/lib/notifications.ts`** (exposed via `shell/session`'s existing
   `./session` federation export — same module the suite already imports for
   `apiFetch`/`usePermissions`) adds:
   - `raiseNotification(input): Promise<Notification>` — the raise-capability seam
     (US-4). Wraps `apiFetch(POST {notifyBase}/notifications)`.
   - `useUnreadCount(): number` — SSE-driven, module-scope, seeded from REST on connect;
     the single shared count for the suite (mirrors `usePermissions()`'s listener-set
     pattern already in `session.ts`).
   - `resetUnreadCount(): void` — optimistic local zero, called by `notify-ui` the instant
     the center opens for immediate badge clear in the acting tab (AC-3.1); the
     server-side `unread-reset` SSE event reconciles the other tabs.
   - `getNotifyBaseUrl(): string` — reads `VITE_NOTIFY_API_URL` (mirrors `getAuthBaseUrl`);
     remotes build notify-api URLs against it.
   - Internal **SSE connection manager**: opens one `EventSource` per tab (lazy, on first
     `useUnreadCount`/shell mount), authenticated by a stream ticket (see below), handles
     `notification` / `unread-reset` events, and emits toast-worthy events to the toast host.
     Closed and re-established across `signOut()` (extend the existing `signOut` wrapper in
     `session.ts`, which already clears the JWT + permissions caches).
3. **`shell/src/components/ToastHost.tsx`** — a shell-chrome overlay mounted once in
   `ShellLayout.tsx`, subscribed to the SSE manager's toast stream (US-5). It overlays
   whichever remote is mounted, satisfying "a toast in the app the user currently has
   open" with a single shell-owned host.
4. **Trusted origins / routing wiring**: add `VITE_NOTIFY_API_URL` to
   `getTrustedOrigins()` in `session.ts`; register the `notify` remote in
   `shell/vite.config.ts`, `shell/src/lib/runtimeRemotes.ts`, and a **new always-available
   `/notify/*` catch-all route** in `shell/src/router.tsx` mounting `notify/App`.

**The `/notify` route is deliberately NOT a permission-gated `tools.ts` entry.** Every
signed-in user has notifications (US-6) and the spec's non-goal forbids re-gating
notification visibility by app-access. So `/notify` is reachable by any authenticated user
and is NOT added to the `usePermissions().apps`-filtered sidebar `TOOLS` list — it is
reached from the bell, not the nav. This is an intentional divergence from the
estimai/refund/admin app-access pattern, justified by the spec.

### Raise → persist → push → badge/toast (sequence)

```
EstimAI (remote)                 shell/session            notify-api                 all the user's tabs
──────────────────────────────────────────────────────────────────────────────────────────────────────
raiseNotification({title,body,   apiFetch POST
  severity, originApp, link?,  ─▶ /notifications  ───────▶ jwtMiddleware (JWKS, sub)
  toast:true})                                             validate title+body (AC-4.5)
                                                           INSERT notification(recipientId=sub)
                                                           publish(sub, event) ──────▶ EventBus
                                                           201 {notification}                │
                                 ◀── 201 ─────────────────                                   │
                                                             each open SSE conn for sub  ◀────┘
                                                             emits  event: notification\n
                                                                    data: {…, toastWorthy}\n\n
                              SSE manager (each tab): ─▶ useUnreadCount()++  (re-sync from REST)
                                                       ─▶ if toastWorthy → ToastHost pops toast (US-5)
```

Bell badge updates in every open tab within ~2s (AC-1.4/1.5); the notification is durable
in `notify-api` regardless of whether any tab was open (AC-5.6, US-6). Opening `/notify`
(`notify-ui`) fetches `GET /notifications`, captures the currently-unread id set, calls
`resetUnreadCount()` (instant local badge clear) then `POST /notifications/mark-all-read`
(server truth + `unread-reset` broadcast to sibling tabs); the captured set drives the
transient "was-unread" affordance for that viewing session only (AC-3.1/3.2/3.3).

### SSE stream authentication (the hard point)

`EventSource` cannot set an `Authorization` header, so the ADR-0005 Bearer path does not
reach the stream. Three options weighed:

- **(A) JWT in query param** — `?token=<7-day-jwt>`. Rejected: puts a long-lived credential
  into the URL → server access logs, browser history, `Referer`, proxy logs. A leaked
  stream URL is 7 days of access. Worst posture, especially for regulated-sector bodies.
- **(C) Cookie (`EventSource(..., {withCredentials:true})`)** — Rejected: forces notify-api
  to consume the better-auth **session cookie**, not the JWKS-verified JWT, breaking the
  ADR-0005 pure-resource-server pattern (it would have to share the session DB or call
  `GET /auth/get-session`). Also reintroduces the fragile cross-origin `SameSite=None`
  third-party-cookie dependency ADR-0006 R7 already flagged.
- **(B) Short-lived, single-use stream ticket (CHOSEN)** — the client calls
  `POST /notifications/stream-ticket` on the normal Bearer/JWKS path (`apiFetch`), getting
  back an opaque, single-use ticket with a ~30s TTL bound to `sub`. It then opens
  `EventSource({notifyBase}/notifications/stream?ticket=<t>)`. The stream endpoint
  consumes the ticket (validates unused + unexpired, resolves `sub`), then streams. The
  long-lived JWT never enters a URL; the only URL-borne credential is a ≤30s single-use
  value whose leakage (logs/history/referer) is near-worthless. A fresh ticket is minted
  for every (re)connect, so a signed-out/expired session cannot re-establish a stream.

  **Trade-off (for the owasp pass):** one extra round-trip before the stream opens, and a
  server-side ticket store. v1 uses an in-process `Map<ticket,{sub,expiresAt}>` — correct
  for a single instance only (see Risks R2). The ticket authenticates the *handshake*; the
  stream then stays open for that `sub` until disconnect or `MAX_STREAM_DURATION` (a
  bounded lifetime forces periodic re-ticket, the only revocation lever a pure JWKS
  verifier has).

### ADRs this builds on / triggers

- **ADR-0005 (JWKS verify)** — followed verbatim for every REST endpoint and the ticket
  mint. **CRITICAL:** notify-api is the suite's **first real *second* JWKS resource
  server** (ADR-0007 §5 kept the admin API inside `auth` precisely so it would *not* be
  one, and gated ADR-0005's deferred `aud` hardening on "the first real second resource
  server (refund-api)"). notify-api now arrives before refund-api and **trips that
  trigger**: a token minted for estimai-api is structurally valid at notify-api and vice
  versa. Recommendation: do the `aud` coordination now (auth sets `aud` via the jwt
  plugin's `audience`; estimai-api + notify-api verify `audience`) rather than defer again.
  See ADR candidates + Security + Risks R7. (This does not change the spec; it is an
  infra/security decision the plan surfaces.)
- **ADR-0006 (Module Federation)** — notify-ui is a standard remote; the bell/SSE/toast
  seam is exposed from `shell/session` exactly like `apiFetch`/`usePermissions`.
- **ADR-0007 (authz)** — notify-ui is intentionally *not* app-access-gated (see above).

## Data model

New Prisma schema `notify-api/prisma/schema.prisma` (generator/datasource identical to
estimai-api). Migration approach: **Prisma migrate** (`bun run db:migrate` dev,
`db:deploy` in the Railway `preDeployCommand`), one `init` migration; never edit existing
migrations — same conventions as estimai-api/auth.

```prisma
model Notification {
  id          String    @id @default(cuid())
  // The recipient's user id = JWT `sub` (ADR-0005). v1: always == the caller's sub.
  // NOT a foreign key — notify-api is a resource server with no user table (users
  // live only in the auth DB); ownership is enforced by the sub predicate, like
  // estimai-api's Estimate.userId.
  recipientId String
  title       String
  body        String
  severity    String    // "info" | "success" | "warning" | "error" (zod-enum at the boundary)
  originApp   String    // "estimai" | "refund" | "admin" | … (zod-enum at the boundary)
  linkHref    String?   // optional in-suite relative path, e.g. "/estimai/estimates/abc"
  linkLabel   String?   // optional action label, e.g. "Open this estimate"
  toastWorthy Boolean   @default(false) // did this ALSO pop a live toast at raise time
  readAt      DateTime?               // null = unread; set = read (AC-3.1)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  @@index([recipientId, createdAt(sort: Desc)]) // list newest-first (AC-2.3)
  @@index([recipientId, readAt])                // unread-count / mark-all-read (AC-1.2, AC-3.1)
  @@map("notification")
}
```

Notes:
- `severity`/`originApp` are `String` (not Prisma enums) to match the codebase convention
  (auth's `PermissionRule.resource/action`, estimai-api's fields validate the closed set at
  the zod boundary, keeping DB migrations off the critical path when the set grows).
- **No "was-unread" column.** AC-3.2/3.3's "was-unread" affordance is a client viewing-session
  concept (the set `notify-ui` captured at open), not durable state — the backend only tracks
  `readAt`. This is what makes AC-3.3 (gone after reload) fall out for free.
- No retention/expiry field (spec non-goal: no retention policy).

## API contracts

Base URL `{notifyBase}` = `VITE_NOTIFY_API_URL` (prod `https://notify-api.operai.welld.io`,
local `http://localhost:8081`). All REST endpoints behind `jwtMiddleware` (ADR-0005:
RS256+issuer pinned, `sub`→`recipientId`, not-owned indistinguishable from not-found).
Errors are RFC 7807 Problem JSON; timestamps ISO 8601.

### `POST /notifications` — raise (US-4)

```jsonc
// Request (zod-validated). recipient is DELIBERATELY ABSENT in v1 — the seam grows it
// later (optional) without breaking callers; the server always uses the JWT sub.
{
  "title":     "Export finished",            // required, 1..200 (AC-4.5 → 400 if empty)
  "body":      "Your XLSX export is ready.", // required, 1..2000 (AC-4.5 → 400 if empty)
  "severity":  "success",                    // enum: info|success|warning|error (default "info")
  "originApp": "estimai",                    // enum of known app ids
  "link":      { "href": "/estimai/estimates/abc", "label": "Open" }, // optional; href MUST be
                                                                      // a relative in-suite path
                                                                      // (open-redirect guard)
  "toast":     true                          // optional, default false → toastWorthy
}
// 201 → { id, title, body, severity, originApp, link?, toastWorthy, readAt:null, createdAt }
// 400 → Problem (missing/empty title or body; bad severity/originApp enum; non-relative link.href)
// 401 → Problem (missing/invalid Bearer)
// 413 → Problem (body over size cap — reuse estimai-api's bodyLimit pattern, small cap)
```

Forward-compat seam (Refund driver): the future `recipient` (a `sub`, or later a group)
is an **optional** field; adding it is additive. v1 hard-ignores any client-sent recipient
and derives `recipientId` from the JWT `sub` only (OWASP A01 — never trust the body for
identity, exactly as estimai-api does).

### `GET /notifications` — list caller's notifications (US-2, US-6)

```jsonc
// Query: ?limit=50&cursor=<createdAt|id cursor>  (default limit 50, cursor pagination)
// 200 → { items: Notification[], nextCursor: string | null }
//        items ordered createdAt DESC (AC-2.3); [] for a user with none (AC-2.4 — not an error)
//        scoped to sub → user B never sees user A's (AC-6.2)
// 401 → Problem
```

### `GET /notifications/unread-count` — bell seed / reconnect resync (US-1)

```jsonc
// 200 → { count: number }   // exact server truth; the badge formats the "9+" cap client-side
// 401 → Problem
```

### `POST /notifications/mark-all-read` — center-open transition + explicit control (US-3)

```jsonc
// No body. Marks every currently-unread notification for sub as read (readAt := now()).
// Idempotent: harmless no-op when nothing is unread (AC-3.4).
// Side effect: publishes an `unread-reset` SSE event to all of sub's open streams so
// sibling tabs clear their badge too (AC-3.1 across tabs).
// 200 → { updated: number, count: 0 }
// 401 → Problem
```

### `POST /notifications/stream-ticket` — mint SSE handshake credential

```jsonc
// Bearer/JWKS-authed (apiFetch). Single-use, sub-bound, short TTL.
// 200 → { ticket: string, expiresIn: 30 }   // seconds
// 401 → Problem
```

### `GET /notifications/stream?ticket=<t>` — the SSE push stream

Not behind `jwtMiddleware` (EventSource sends no header); authenticated by the ticket.
Content-Type `text/event-stream`; CORS `Access-Control-Allow-Origin: <shell origin>`.

```
event: notification
data: { "id":"…", "title":"…", "body":"…", "severity":"success",
        "originApp":"estimai", "link":{…}?, "toastWorthy":true,
        "readAt":null, "createdAt":"2026-07-13T…Z" }

event: unread-reset
data: { "count": 0 }

: heartbeat            <- comment line every ~15s; keeps the connection alive, lets the
                          client detect a dead stream and reconnect (with a fresh ticket)
```

- Invalid/expired/already-used ticket → `401` (Problem JSON) and the stream never opens.
- On (re)connect the client re-syncs via `GET /notifications/unread-count` (and, if the
  center is open, `GET /notifications`) so events missed while disconnected are recovered
  from persistence — SSE is a nudge, the DB is the source of truth (covers AC-5.6, R3).
- Server closes the stream at `MAX_STREAM_DURATION` (env, ~30 min) forcing a re-ticket.

### `GET /health` — health incl. DB + JWKS readiness

Mirror estimai-api's health route; additionally report JWKS-verifier readiness (ADR-0005
cold-start note) and active SSE connection count for ops visibility.

## Test strategy

Levels: **unit** = Vitest (FE components/hooks) or `bun test` (BE handlers/schemas);
**integration** = notify-api routes/SSE against real Postgres + minted real JWT (mirrors
estimai-api's `*.routes.test.ts` + the T-JWKS-identity pattern); **e2e** = Playwright over
the assembled shell + notify-ui + notify-api with a seeded session (shell `e2e/` harness).
Mapping is total over all 29 ACs.

| AC | What proves it | Level |
|----|----------------|-------|
| AC-1.1 | Bell renders in `Header` beside `ThemeToggle`; present on every route incl. estimai/refund/admin | unit (Bell/Header) + e2e |
| AC-1.2 | Badge shows count when unread > 0 | unit (Bell) |
| AC-1.3 | No badge when unread == 0 | unit (Bell) |
| AC-1.4 | SSE `notification` event → `useUnreadCount` increments, no reload | integration (fan-out) + e2e (raise → badge) |
| AC-1.5 | Two contexts/tabs both update ≤~2s on one raise | e2e (multi-context) + integration (multi-conn same sub) |
| AC-1.6 | 0→none, 1→"1", 9→"9", 10→"9+", 99→"9+" (see Risks: boundary wording clarified) | unit (Bell badge formatter) |
| AC-2.1 | Activating bell navigates to `/notify`; center renders list | unit (Bell onClick) + e2e |
| AC-2.2 | Item shows title, body/preview, timestamp, read/unread state, severity, origin app | unit (NotificationItem) |
| AC-2.3 | List ordered newest-first | integration (list ordering) + unit (render order) |
| AC-2.4 | Empty list → explicit empty state (not blank/error) | unit (center empty state) + e2e |
| AC-2.5 | Item with link → activating navigates to destination; item already read | unit (link follow) + e2e |
| AC-3.1 | Open center → all unread → read; badge clears immediately + across tabs | integration (mark-all-read + `unread-reset`) + e2e (open→0) + unit (resetUnreadCount) |
| AC-3.2 | "was-unread" affordance persists for the open viewing session | unit (captured-set state) + e2e |
| AC-3.3 | Reopen/reload → no was-unread affordance; prior-read shown plain-read | unit (fresh mount) + e2e (reload) |
| AC-3.4 | Explicit "mark all read" works; no-op when nothing unread | unit (button→call) + integration (idempotent 200) |
| AC-4.1 | Raise carries title+body, appears in caller's center; body-sent recipient ignored (sub only) | integration (persist recipientId=sub) + unit (raiseNotification shape) |
| AC-4.2 | Severity accepted + rendered visually distinct | integration (severity validate/persist) + unit (severity styling) |
| AC-4.3 | Optional link accepted (relative-only) + followable | integration (link validate/persist) + unit (render/follow) |
| AC-4.4 | originApp recorded + shown in center | integration (persist) + unit (render origin) |
| AC-4.5 | Missing title or body → 400 Problem, reported to raiser | integration (400) + unit (schema reject) |
| AC-5.1 | toast-worthy + suite open → transient toast in current app | e2e (raise→toast over mounted remote) + unit (ToastHost on SSE toast event) |
| AC-5.2 | Toast auto-dismisses after a short period | unit (ToastHost timer) |
| AC-5.3 | User dismisses early → immediate, no reappear | unit (ToastHost dismiss) |
| AC-5.4 | toast-worthy also retained in center in same read/unread state | integration (persisted unread) + e2e (dismiss→still in center unread) |
| AC-5.5 | Not toast-worthy → no toast anywhere; center only | e2e + unit (SSE manager: non-toast event emits no toast) |
| AC-5.6 | Raised while suite closed → no toast later, present in center in correct state | integration (list includes, unread) + e2e (connect after raise → no toast, present) |
| AC-6.1 | Reload same device / sign in other device → list + read state unchanged | integration (persistence) + e2e (reload) |
| AC-6.2 | Two users → neither sees the other's; B fetching A's id → 404 | integration (sub-scope + not-owned 404) + e2e |
| AC-6.3 | Sign out A, sign in B same device → B sees only own | e2e (signOut clears caches + SSE reconnects as B) + integration |

## Risks

- **R1 — SSE authentication / credential-in-URL.** EventSource can't send Bearer.
  *Mitigation:* chosen short-lived single-use stream ticket (Option B above); the 7-day JWT
  never enters a URL. owasp surface — see Security.
- **R2 — Multi-instance fan-out + ticket store.** The in-process connection registry and
  in-memory ticket `Map` are correct for **one** instance only; a second replica splits
  both the fan-out and the mint↔connect affinity. *Mitigation:* v1 ships single-instance
  (pin `numReplicas: 1` / no autoscale in `railway.json`, assert in an early check); design
  `publish()` behind an `EventBus` interface and the ticket store behind an interface so
  **Postgres `LISTEN`/`NOTIFY`** (already have Postgres) + a shared ticket table slot in
  when scaling is needed. No app rewrite required to scale.
- **R3 — Reconnect gaps / missed-while-disconnected.** Events raised during a dropped
  connection are lost on the wire. *Mitigation:* persistence is source of truth; every
  (re)connect re-syncs unread-count (and list if the center is open) via REST. Also the
  mechanism behind AC-5.6. Early check: kill the stream mid-test, raise, reconnect, assert
  the count reconciles.
- **R4 — Multi-tab dedupe / count divergence.** The same event hits N tabs. *Mitigation:*
  the unread count is authoritative from the server on connect and reconciled on events;
  local increments are hints only, so tabs can't drift. A toast per open tab is acceptable
  (each open app legitimately shows it).
- **R5 — Delivery semantics.** SSE push is best-effort (at-most-once on the wire); exactly-
  once is neither achievable nor needed. *Mitigation:* durability lives in the DB, not the
  stream; toasts are transient by definition. Documented, not engineered around.
- **R6 — CSP / CORS for two new origins.** The shell CSP **`connect-src`** must include the
  notify-api origin — **SSE (`EventSource`) is governed by `connect-src`**, a classic miss;
  `script-src` **and** `connect-src` must include the notify-ui remote origin; add both to
  `auth` `ALLOWED_ORIGINS`, notify-api `ALLOWED_ORIGINS`, the `apiFetch` trusted-origin
  allowlist (`VITE_NOTIFY_API_URL`), `runtimeRemotes.ts`, and `shell/vite.config.ts`.
  *Mitigation:* enumerate all origins per env up front (shell `vercel.json` CSP is the
  single chokepoint — add `notify.operai.welld.io` + `notify-api.operai.welld.io` there);
  the owasp pass verifies the pinned allowlist.
- **R7 — `aud` hardening trigger (ADR-0005).** notify-api is the first real second JWKS
  resource server → tokens are cross-valid between estimai-api and notify-api.
  *Mitigation:* coordinate the `aud` claim before notify-api hits production — auth sets
  `audience` in the jwt plugin; both resource servers verify `audience` (add `AUTH_AUDIENCE`
  env). Recommend doing it now rather than deferring again; see ADR candidates.
- **R8 — Long-open stream vs sign-out/revocation.** A pure JWKS verifier has no revocation;
  a stream opened pre-sign-out could linger. *Mitigation:* `signOut()` (shell/session)
  closes the EventSource; `MAX_STREAM_DURATION` bounds server-side stream life; a re-ticket
  requires a currently-valid JWT so a signed-out user cannot re-establish.
- **R9 — Provisioning two services.** New Vercel project (notify-ui) + Railway EU service
  (notify-api) + `notify` DB + `mise.toml` dev wiring + `compose.yaml` service. *Mitigation:*
  clone estimai-api's `railway.json`/Dockerfile and admin-ui's `vercel.json` verbatim;
  early check replicates EU region + runtime-config wiring before trusting either deploy.
- **R10 — `originApp` spoofing.** v1 trusts the body's `originApp` label. *Mitigation:* low
  risk because recipient is always the caller (no cross-user spoof); constrain to a zod enum
  of known app ids; revisit when the recipient seam grows (owasp note).

## Security

**Security-sensitive: YES.** notify-api is a new authenticated resource server holding
per-user data, with a novel authenticated SSE stream. Schedule the owasp-reviewer pass in
parallel with QE. Named surfaces to review:

- **SSE authentication** — the stream-ticket mint (`POST /notifications/stream-ticket`) and
  the stream endpoint (`GET /notifications/stream`): single-use enforcement, ≤30s TTL,
  sub-binding, no long-lived credential in any URL, ticket-store isolation.
- **JWKS resource-server posture** (ADR-0005) — RS256+issuer pinning, `sub`→`recipientId`,
  not-owned → 404 not 403 (IDOR/existence-leak), no DB access before verification.
- **`aud` cross-service token replay** (R7) — the first second-resource-server case;
  confirm the `aud` decision before production.
- **Per-user scoping** (AC-6.2/6.3) — every query filtered by `sub`; caches cleared on
  sign-out; SSE re-authenticates as the new user after a user switch.
- **`link.href` open-redirect / XSS** — must be a relative in-suite path (reject
  `javascript:`, absolute/external origins); the center renders it as a route navigation,
  not `window.location = untrusted`.
- **Raise abuse / rate-limiting** — spec non-goal but an operational concern: any app can
  raise for the caller; note a per-sub rate cap as owasp follow-up.
- **CSP/CORS** for the two new origins incl. `connect-src` for SSE (R6).
- **Data residency** — notify-api EU-only (Railway `europe-west4`); bodies (which may name
  clients/estimates) never logged (reuse estimai-api's logger posture).

## ADR candidates

1. **SSE stream authentication via short-lived single-use ticket** — establishes the
   suite's real-time-push auth pattern (mint-on-Bearer → open-on-ticket), constraining
   every future SSE/streaming feature. Records the rejection of query-param-JWT and
   session-cookie.
2. **Notification center as a standalone JWKS resource service + federated remote with a
   shell-owned bell/SSE/toast seam** — the push/real-time counterpart to ADR-0006, incl.
   the recipient-forward-compatible raise-capability seam and the deliberate non-gating of
   `/notify` by app-access.
3. **Trigger / amend ADR-0005's deferred `aud` hardening** — notify-api is the first real
   second resource server; either a new ADR or an amendment to ADR-0005 recording that the
   trigger fired and the `aud` claim is now set by `auth` and verified by both resource
   servers. (Constrains the auth token shape + every current/future resource server.)

---

**Proposed spec clarification (non-blocking).** AC-1.6 / Constraint 6 say "the exact count
for 1 through 9 and '9+' for any count of 9 or more" — the two clauses overlap at exactly
9. The plan interprets **1–9 shown exactly, 10+ shown as "9+"** (the specific "exact for 1
through 9" clause wins; "9 or more" is loose wording), and the AC-1.6 test is pinned to
that. Please confirm, or amend the spec wording to "1 through 8 … '9+' for 9 or more" if
9 should read "9+". This is the only mapping ambiguity found; no other AC is unmappable.
