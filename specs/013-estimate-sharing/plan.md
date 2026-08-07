---
spec: 013
status: approved
approved: 2026-08-07
---

# Plan: Estimate sharing — invite registered EstimAI users to collaborate on an estimate

## Architecture

### What this feature actually changes

Three services and one frontend are touched. The shape of the change, in one line each:

- **`estimai-api`** becomes the owner of a new **record-level access-control list** (an
  `estimate_collaborator` table) and of **optimistic concurrency** on the estimate document.
  Every owner-scoped query widens to "owner OR granted collaborator". It gains two new
  outbound seams: `auth` (eligibility + identity) and `notify-api` (grant/removal push).
- **`auth`** gains two new **Bearer-authed** endpoints that answer questions about a
  **third party** — something no endpoint in the suite does today (`/authz/me` and
  `/authz/resolve` are strictly caller-own). Both are decision/identity endpoints, not
  directory endpoints (see "The third-party lookup" below).
- **`notify-api`** is unchanged. `estimai-api` becomes the **third** holder of
  `NOTIFY_INTERNAL_TOKEN` via the existing `POST /system/notifications` (ADR-0017).
- **`estimai-ui`** gains a collaborator dialog (distinct from the existing link share),
  capability-gated editing, shared-row rendering in the list, and conflict recovery.

```
                       ┌───────────────────────────────────────────────┐
                       │ estimai-ui (federated remote, basepath /estimai)│
                       │  CollaboratorsDialog │ ConflictBanner │ list   │
                       └───────────────┬───────────────────────────────┘
                                       │ apiFetch (Bearer JWT, ADR-0001)
                                       ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │ estimai-api  (JWKS resource server, ADR-0005/0010 — identity only)   │
   │   estimates/*  ── access resolution: owner | editor | viewer          │
   │   estimates/{id}/collaborators/*  (owner-gated ACL CRUD)             │
   └───┬─────────────────────────┬──────────────────────────┬─────────────┘
       │ forwarded caller JWT    │ forwarded caller JWT     │ X-Internal-Token
       │ POST /authz/            │ POST /authz/users/       │ POST /system/
       │      app-access-check   │      identities          │      notifications
       ▼                         ▼                          ▼
   ┌────────────────────────────────────┐          ┌──────────────────────┐
   │ auth   (resolver, ADR-0007/0014)   │          │ notify-api (ADR-0017)│
   │  eligibility DECISION (no facts)   │          │  inApp channel       │
   │  identity by id (no search)        │          └──────────────────────┘
   └────────────────────────────────────┘
                                       ▲
   Postgres (EU) ── estimate + estimate_collaborator (new)
```

### Why `estimai-api` does NOT become an authorization-enforcing resource server

`refund-api` gates every route on `auth GET /authz/resolve` (ADR-0014) because *its*
authorization rules (`request:review`, entity ABAC) live in `auth`'s role model. This
feature's rules do **not**: "who may open estimate X" is a per-record grant that only
`estimai-api` knows. Spec Constraints are explicit that EstimAI *app* access stays gated at
the shell boundary (ADR-0007 US-7) and that this feature must not duplicate it.

Consequence, deliberately chosen: **`estimai-api`'s read/write path acquires no runtime
dependency on `auth`.** A collaborator can open and save a shared estimate while `auth` is
down (their JWT still verifies against cached JWKS). Only two narrow paths call `auth`:
adding a collaborator (fails **closed**, 503 — ADR-0014's posture, because it is an
authorization decision) and display-identity resolution (fails **soft** to an "unknown"
placeholder, because it is decorative and never gates access). This split is a better
availability posture than `refund-api`'s and is stated here so it isn't later "fixed" into
a blanket fail-closed.

We do **not** add `authzMiddleware`, and we do **not** start enforcing the already-declared
but unenforced `estimate:view/create/edit/delete` catalog actions
(`auth/src/authz/catalogs/estimai.ts`). Those remain declaration-only, exactly as specs/004
AC-3.4 shipped them. Turning them on would be a separate, much larger feature and is not
what this spec asks for.

### The third-party lookup (AC-1.1/AC-1.2) — the hard problem

`estimai-api` must answer: *is this email address an active Operai user who holds EstimAI
app access?* Nothing in the suite answers questions about a third party today.

**Trust model — the two candidates, weighed.**

| | Forwarded caller JWT (ADR-0014 pattern) | Internal shared token (ADR-0011 pattern) |
|---|---|---|
| New secret | none | a **new** `AUTH_INTERNAL_TOKEN` (the existing one is notify-api's) |
| Caller attributable | yes (`sub` on the token) | no |
| Per-caller rate limiting | natural (`sub`) | impossible (one identity for all traffic) |
| Auditability of *who* probed | yes | no |
| Directly callable by an end user with their own token | **yes** | no |
| ADR lineage | ADR-0014, ADR-0005 | ADR-0011/0017 (escalation trigger already fired twice) |

**Decision: forwarded caller JWT.** An internal token would put an inbound service-trust
surface on the *identity service itself* — the one service where a leaked static secret is
most consequential — and would make the endpoint unattributable and un-rate-limitable
precisely where per-caller limits are the primary anti-abuse control. Introducing a third
static shared secret while ADR-0011's escalation trigger is already twice-fired would be
indefensible. The forwarded-JWT model introduces no new credential at all.

**The catch, and how it is resolved.** Under the forwarded-JWT model the endpoint is
reachable *directly* by any end user holding their own token (they can read it out of the
browser and `curl` it; CORS is not a security control against a non-browser client). If that
endpoint returned *facts* ("no such user" vs. "user exists, no EstimAI access"), AC-1.2's
anti-enumeration property would be defeated for anyone technical enough to bypass the UI.

Therefore **the endpoint returns a decision, not a fact**:

```
POST /authz/app-access-check   →   { "eligible": true, "userId": "…" }
                               →   { "eligible": false }        ← BOTH negative causes
```

AC-1.2 requires exactly that the *two negative causes* be indistinguishable; positive vs.
negative is inherently observable (the share succeeds or it doesn't). A boolean-eligibility
endpoint collapses the two causes at the **source**, so the property holds no matter who
calls it and by what route. `estimai-api`'s generic-ization is then a second layer, not the
only one.

**Who may call it:** the caller must themselves hold `(appId, "access")` — resolved in
`auth` with the existing `resolveEffectivePermissions` (no new catalog permission, no seed
change, no round trip). A soft-deleted caller (residual JWT, ADR-0012) is rejected 403.
Only someone who can use EstimAI can ask about EstimAI collaborator eligibility.

**Soft-deleted targets** (ADR-0012) are `eligible: false` — the target predicate is
`deletedAt IS NULL`. Their `user` row still exists, so this must be an explicit predicate,
not an implicit consequence of absence.

**Timing identity (AC-1.2) — the concrete mechanism.** Two layers, because the endpoint is
directly callable:

1. **Equalised work inside `auth`.** The two negative paths must execute the same query
   shape. Without care, "no such user" costs one indexed probe and "user exists, no access"
   costs a probe *plus* the resolver's two `findMany`s — a measurable delta.
   - The email probe is a parameterised `WHERE lower(email) = $1 AND "deletedAt" IS NULL
     LIMIT 1` against a **new functional index** `CREATE INDEX user_email_lower_idx ON
     "user" (lower(email))`, so hit and miss are both single index probes (a `mode:
     "insensitive"` Prisma filter emits `ILIKE`, which cannot use that index and would seq-scan
     — deliberately not used).
   - `resolveEffectivePermissions` is invoked **on every path**, including the no-such-user
     path, against a fixed non-existent sentinel id. Both `findMany`s still execute and
     return empty. The result is discarded on that path.
2. **A response-time floor.** `auth` floors every `eligible: false` response to
   `APP_ACCESS_CHECK_FLOOR_MS` (default 150 ms) — `await sleep(max(0, floor - elapsed))`.
   `estimai-api` independently floors its whole generic-rejection response to
   `SHARE_LOOKUP_FLOOR_MS` (default 300 ms), covering the round trip. Both are quantised to
   a constant, so the residual signal is bounded by clock jitter well below network noise.
   The success path is **not** floored (positive/negative distinction is permitted).

"Timing-identical" is therefore implemented as **quantised to a fixed floor with an equalised
work path**, and is asserted as such in the test strategy (both causes' medians differ by
< 10% of the floor over N samples). Perfect timing identity is not achievable on a networked
service; this is the honest, testable reading of AC-1.2 and is called out under Risks.

**Rate limiting (the share dialog is now a probe endpoint).** The suite has **no rate
limiting anywhere today** — this is the first. A small in-process sliding-window limiter
(`Map<sub, timestamps[]>`, no new dependency, periodic prune):

- `estimai-api POST /estimates/{id}/collaborators` — **20 attempts / 10 min per caller
  `sub`**, counted on **every** attempt (success, duplicate, self, and generic rejection
  alike — counting only failures would leave a valid-email prober unthrottled). Applied
  **before** the `auth` call, so it also shields `auth`.
- `auth POST /authz/app-access-check` — **40 attempts / 10 min per caller `sub`**, so
  `estimai-api`'s limit binds first in the normal flow while the directly-callable surface
  is still protected.
- Both return `429` Problem + `Retry-After`.

Limitation, stated: in-process counters are per-instance. `estimai-api` and `auth` run
single-instance on Railway today; a future horizontal scale-out needs a shared store. Named
in Risks, not solved here.

### Access resolution inside `estimai-api`

One helper, `src/estimates/access.ts`:

```ts
type AccessLevel = "owner" | "editor" | "viewer";
resolveAccess(estimateId, callerId): Promise<{ level: AccessLevel; version: number;
                                               ownerId: string } | null>
```

Single query: fetch the estimate by id, including only the caller's own collaborator row.
`row.userId === callerId → owner`; else the collaborator row's level; else `null`.

**Denial taxonomy — a deliberate narrowing of ADR-0005's "not owned = 404".** ADR-0005 chose
404 for a not-owned record so "not yours" and "does not exist" are indistinguishable. In a
world with sharing, that rule needs one distinction:

- **No relationship at all → 404.** Exactly AC-1.6 / ADR-0005, unchanged. A stranger learns
  nothing about the estimate's existence.
- **Has a relationship but lacks the level → 403** (`code: "insufficient_access"` /
  `"owner_only"`). A viewer attempting `PUT`, or any collaborator attempting `DELETE` or
  collaborator management (AC-3.1/AC-3.3/AC-1.5), already *knows* the estimate exists — they
  can open it. A 404 here would leak nothing but would be a lie, and would make the UI unable
  to distinguish "gone" from "not allowed". This mirrors ADR-0014's split (capability absent
  → 403; record-level not-yours → 404) applied to record-level grants.

Reads and writes never do a two-step check-then-act on the write path: the CAS `updateMany`
embeds the access predicate (see API contracts), so there is no TOCTOU window — the same
structural property `estimates.repo.ts` already relies on today.

**Touched call sites** (all in `estimai-api/src/estimates/estimates.repo.ts`):

| Function | Today | After |
|---|---|---|
| `createEstimate` | `userId` = caller | unchanged (owner is always the creator) |
| `listEstimates` | `where: { userId }` | `where: { OR: [{ userId }, { collaborators: { some: { userId } } }] }`, plus the caller's own collaborator row `include`d to derive `access`, plus `userId` selected to derive `owner` identity |
| `getEstimateById` | `where: { id, userId }` | `where: { id }` + `resolveAccess`; `null` → 404 |
| `updateEstimate` | `updateMany({ where: { id, userId } })` | CAS `updateMany({ where: { id, version, OR: [owner, editor-collaborator] } })` + `version: { increment: 1 }` |
| `deleteEstimate` | `deleteMany({ where: { id, userId } })` | unchanged predicate (owner-only); `count === 0` → `resolveAccess` decides 403 vs 404 |
| import (`POST /estimates/import`) | caller-owned creates | unchanged — import never creates grants |

### Optimistic concurrency (US-4)

**Mechanism: an integer `version` column + HTTP `If-Match`/`ETag`, enforced by a
single-statement compare-and-swap.**

Rejected alternatives:
- **`updatedAt` precondition.** Millisecond/microsecond granularity mismatch between
  Postgres `timestamptz` and an ISO-8601 JSON round trip makes equality comparison fragile
  (a truncated microsecond silently never matches, turning every save into a false conflict);
  and two saves inside the same tick are indistinguishable. Rejected on correctness.
- **An opaque content hash ETag.** Costs a full content read + hash on every write and gives
  nothing an integer doesn't.
- **`expectedVersion` in the JSON body.** Works, but conflates a precondition with the
  payload and forfeits the standard 428/412 semantics. Rejected on hygiene, not correctness.

**`If-Match` is REQUIRED on `PUT`.** AC-4.1/AC-4.4 demand detection on *every* save,
including a solo owner's second tab, so an absent precondition cannot silently fall back to
last-write-wins — a mixed old-client/new-client fleet would then reintroduce exactly the
clobber the spec is closing. Absent/malformed → **428 Precondition Required**. Deployment
consequence (a browser tab loaded before the rollout starts 428-ing on its next autosave) is
real and mitigated by mapping 428 to the same "reload required" UX as 409 — self-healing on
one click. Named in Risks.

Atomicity (AC-4.3): the write is one statement —
`UPDATE … WHERE id = $1 AND version = $2 AND <access predicate>` with
`version = version + 1`. Postgres serialises the two concurrent updates; exactly one matches
`version = $2`, the other's `count` is 0. No partial merge is possible because the document
is written whole (ADR-0004, unchanged).

Distinguishing `count === 0` afterwards: re-read via `resolveAccess` — no relationship → 404,
insufficient level → 403, otherwise → 409 with the current version. Access is evaluated
before the conflict is reported, so a stranger probing a random id with an `If-Match` header
always gets 404, never a 409 that would confirm existence.

**This supersedes spec 001's accepted last-write-wins Non-goal and the LWW clause of
ADR-0004** — for every write, not only multi-collaborator ones (spec Amendments, AC-4.4).
ADR-0004's persistence shape (whole-document JSONB, listing columns, 1 MiB guard, semantic
deep-equal fidelity) is untouched. This is an ADR candidate.

### Display identity (AC-2.1, AC-10.5, collaborator panel)

`estimai-api` stores only opaque `sub`s. Two candidate sources for a human-readable owner:

- **Denormalise the owner's name at estimate-create time.** Impossible for the ~existing
  estimates (no such column, nothing to backfill from) and — decisively — it cannot satisfy
  AC-10.5, which forbids "stale/misleading identity information implying the account is still
  active". A frozen name can never express "this account was deleted". **Rejected.**
- **Resolve live from `auth`.** Chosen.

New endpoint `POST /authz/users/identities`: takes **ids** (≤100, opaque cuids the caller
already holds), returns `{ id, status: "active"|"deleted"|"unknown", name }` with `name`
non-null only for `active`. It accepts no email, no name, no prefix, and no wildcard — it is
an id-keyed resolution, **not** the user-directory/search the spec lists as a Non-goal. That
distinction is the whole security argument and must not erode.

`estimai-api` caches results in-process keyed by `sub` with a 60 s TTL, and calls it in one
batch per list render (distinct owner subs, self excluded). On failure it degrades to
`status: "unknown"` — never an error, never a fabricated identity. Three UI states:
`active` → the name; `deleted` → "Former wellD member" (AC-10.5); `unknown` → a neutral
placeholder.

The collaborator's **email** is *not* resolved live — it is the snapshot stored on the grant
(the owner typed it and thinks in it). Name/status are live on top of it.

### Notifications (US-7) — the third internal caller

`estimai-api` calls `notify-api POST /system/notifications` with `X-Internal-Token`
(ADR-0017), in a dedicated `estimai-api/src/lib/notify.ts` that **never throws** — a
verbatim reuse of `refund-api/src/lib/notify.ts`'s contract. Sent **after** the grant
transaction commits; a failure is logged and never rolls back the grant (AC-7.1 delivery is
additive; the collaborator sees the estimate in their list regardless).

**This makes `estimai-api` the THIRD holder of `NOTIFY_INTERNAL_TOKEN`.** ADR-0011 named "a
second internal caller" as the trigger to escalate to scoped, self-issued service JWTs
(its Option C); ADR-0017 knowingly tripped it and deferred. Tripping it a third time without
a stated position would be exactly the silent drift ADR-0017 warned about. The position taken
here:

- **Reuse the existing mechanism for this feature.** Building Option C now means a new
  `aud`/`scope` convention coordinated across four services for one best-effort notification
  — disproportionate, and it would delay a feature whose security weight sits elsewhere
  (the enumeration oracle).
- **But record a hard stop:** the ADR proposed below should state that a *fourth* internal
  caller, or any suspected leak, builds Option C rather than deferring again — and that
  `estimai-api`'s Railway deployment must carry the same discipline `auth`/`refund-api` do
  (private networking only, token never on a public ingress, never logged).
- Note the blast radius is now three services' compromise → arbitrary email over wellD's
  Resend domain **and** arbitrary in-app push impersonating any suite app.

Payloads (AC-7.1/7.2; AC-7.3 requires **no** notification on edits, saves, exports, or a
viewer↔editor level change):

- **Granted** — `severity: "info"`, `originApp: "estimai"`, title/body naming the estimate
  and the level, `link.href: "/estimai/estimates/{id}"`.
- **Removed (owner-initiated only)** — `severity: "info"`, names the estimate, **no link**
  (the target would 404). Self-leave (US-6) sends nothing.

Compliance note: the notification body carries the **estimate name** (a title, not content)
into `notify-api`'s database. Names can carry a client's name. Both services are EU-region
(ADR-0009), and this is a deliberate, recorded widening of what leaves `estimai-api` — the
alternative (a nameless "an estimate was shared with you") does not satisfy AC-7.1's
"identifying the estimate". The name is truncated to 120 chars.

### Frontend (`estimai-ui`)

- **`src/lib/collaboratorsApi.ts`** (new) — typed wrappers over the five collaborator
  endpoints, `ApiError` reused.
- **`src/lib/estimatesApi.ts`** — `EstimateFull`/`EstimateListItem` gain `access`, `owner`,
  `version`; `update()` sends `If-Match` and returns the new version; a `ConflictError`
  subclass carries `currentVersion` / `lastModifiedBy`.
- **`src/strings.ts`** (new) — every new user-facing string, namespaced keys, English for
  v1, typed so a second locale is a mechanical addition. This is the exact precedent
  `refund-ui/src/strings.ts` set (specs/007 Gate-2). **Scope note:** only *new* copy moves
  here; retro-fitting estimai-ui's existing inline English is out of scope for this feature.
  CLAUDE.md's IT+EN mandate remains unmet suite-wide (no locale switch exists anywhere) —
  called out as an existing, unresolved gap, not silently absorbed.
- **`src/context/EstimatorContext.tsx`** — new `access`, `canEdit`, `version` in context;
  the autosave effect (a) does not run at all when `!canEdit`, (b) sends `If-Match` and
  adopts the returned version on success, (c) on 409/428 enters a `conflict` state and
  **suspends further autosaves** until resolved (otherwise the 1.5 s debounce becomes a
  retry storm), while leaving `name/author/params/releases/acts` untouched (AC-4.2).
- **`src/components/ConflictBanner.tsx`** (new) — non-dismissable banner with a "Reload
  latest" action (route invalidate → remount). "Save as a copy" (a `POST /estimates` of the
  local content) is available at zero API cost as an escape hatch; whether to offer it, and
  the exact wording, is **design.md's call**.
- **`src/components/CollaboratorsDialog.tsx`** (new) — owner-only; email + level input,
  list with level switch and remove; a collaborator sees a read-only "Shared with you by X"
  affordance and a "Leave" action instead.
- **`src/EstimatorApp.tsx`** — the existing toolbar `Share` button (`buildShareUrl`,
  clipboard, QR) is **untouched in behaviour** (AC-8.1) but is proposed to be relabelled
  **"Share link"**, with a new, separate **"Collaborators"** entry alongside it (owner) /
  "Shared with you" chip (collaborator). US-8 requires the two be unmistakably distinct;
  **the exact composition, labels and iconography are design.md's call** — this plan fixes
  only that they are two separate entry points and that neither is folded into the other.
- **Read-only gating** — `readOnly` flows from context into `ActivityTable`,
  `ParametersPanel`, `Header` (name/author inputs), `TemplatePicker`, and the add/delete
  release controls. Server-side 403 is the real control; the UI gating is UX.
- **`src/pages/EstimatesPage.tsx`** — rows render a "Shared" indicator + owner label +
  level chip for `access !== "owner"`; the empty state keys off the combined list length, so
  a user with only shared estimates never sees it (AC-2.3, falls out).
- **`src/pages/EstimatePage.tsx`** — `providerKey` moves from `estimate.updatedAt` to
  `estimate.version`; `initialVersion`/`access` passed through.
- **`src/pages/SharedEstimatePage.tsx`** — **untouched** (AC-8.1/8.2); guarded by a
  regression test asserting no collaborator affordance renders there.

## Data model

`estimai-api/prisma/schema.prisma`. One new table, two new columns, one new enum. **Additive
migration only — existing migration files are never edited.**

```prisma
enum EstimateAccessLevel {
  viewer
  editor
}

model Estimate {
  id                   String   @id @default(cuid())
  userId               String                       // owner's auth `sub` — unchanged, fixed at creation
  name                 String
  author               String   @default("")        // free-text label INSIDE the document —
                                                    // NOT the owner's account identity. Never
                                                    // use it to render AC-2.1's owner.
  sizeBytes            Int
  content              Json
  version              Int      @default(1)         // NEW — optimistic concurrency (US-4)
  lastModifiedByUserId String?                      // NEW — `sub` of the last successful writer,
                                                    // for the 409 conflict message only
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  collaborators EstimateCollaborator[]

  @@index([userId, updatedAt(sort: Desc)])
  @@map("estimate")
}

model EstimateCollaborator {
  id              String              @id @default(cuid())
  estimateId      String
  estimate        Estimate            @relation(fields: [estimateId], references: [id],
                                                onDelete: Cascade)   // AC-9.1
  userId          String                                             // collaborator's auth `sub`
  email           String                                             // lower-cased snapshot at grant time
  accessLevel     EstimateAccessLevel
  grantedByUserId String                                             // owner's `sub` at grant time
  createdAt       DateTime            @default(now())
  updatedAt       DateTime            @updatedAt

  @@unique([estimateId, userId])          // the authoritative "one grant per person" invariant
  @@index([userId, estimateId])           // the collaborator's own list query
  @@index([estimateId, email])            // AC-1.3 duplicate fast path, no auth round trip
  @@map("estimate_collaborator")
}
```

**`sub` *and* email — why both.**

- `userId` (`sub`) is the **only** authorization input. It is immutable and survives an email
  change at the identity provider.
- `email` is a **denormalised label**, never an authorization input. It exists for three
  concrete reasons: (a) AC-1.3's duplicate check runs without an `auth` round trip, closing a
  probe path; (b) the owner added the person by email and the panel must show what they
  typed; (c) it is a stable fallback label if live identity resolution degrades. It is
  explicitly allowed to go stale (a later provider-side email change is not propagated); the
  live `name`/`status` come from `auth` on every render. Storing *only* the email would make
  authorization mutable by the identity provider; storing *only* the `sub` would force an
  `auth` call before every duplicate check and leave the panel with nothing human-readable
  when `auth` is unreachable.

**Cascade behaviour.**

- **US-9 (estimate deleted):** `onDelete: Cascade` on `estimateId`. One statement, no
  application-level sweep. Explicitly **not** `Restrict` — ADR-0018's `Restrict` lineage
  protects *immutable financial audit records*; a collaborator grant is live access state
  whose whole point is that it disappears with the record (AC-9.1). Cargo-culting `Restrict`
  here would make an estimate with collaborators undeletable, directly violating AC-9.1.
- **US-10 (owner soft-deleted):** *nothing happens*, structurally. `estimai-api` has no FK
  to `auth`'s `user` table (separate databases), and ADR-0012 point 3 already fixes that
  "resource servers do nothing at delete time". AC-10.1 is therefore satisfied by the absence
  of a mechanism, not by adding one — and the test asserts exactly that. AC-10.2/10.3 follow:
  a grant references a `sub`, not a liveness state. AC-10.4 follows too — owner-only
  operations require `userId === callerId`, and the soft-deleted owner cannot obtain a
  session (ADR-0012 point 2/3), so no one can perform them. (One residual: ADR-0012's
  accepted residual-JWT window means a *just*-deleted owner's already-issued token still
  authenticates until it expires. This is ADR-0012's explicitly accepted trade-off, not a new
  gap — see Risks.)

**Migration notes.** `version Int @default(1)` and `lastModifiedByUserId` are added with a
non-volatile default / nullable, so Postgres 11+ adds them without a table rewrite. Existing
rows read as `version = 1`. The `auth` side adds one migration: the functional index
`CREATE INDEX user_email_lower_idx ON "user" (lower(email))` (non-unique; the existing unique
on `email` is unaffected). No backfill anywhere.

## API contracts

All errors are RFC 7807 `application/problem+json` `{ type, title, status, detail, instance }`,
extended with a stable machine-readable `code` on the new failure modes (the precedent
ADR-0026/0029 set in `refund-api`). Timestamps ISO 8601.

### `auth` — new

```
POST /authz/app-access-check
  auth: bearerJwtMiddleware (auth/src/authz/resolveAuth.middleware.ts, reused verbatim)
  body: { appId: string  (/^[a-z0-9-]{1,64}$/),
          email: string  (RFC-shaped, <= 320 chars) }

  200 → { "eligible": true, "userId": "clx…" }
  200 → { "eligible": false }
        ── returned when ANY of: no user with that email; user soft-deleted;
           user lacks (appId,"access"). The response body, status, and elapsed
           time are IDENTICAL across all three. No other field is ever added
           to the negative response.
  400 → Problem            malformed appId/email syntax (says nothing about accounts)
  401 → Problem            absent/invalid/expired/wrong-aud Bearer token
  403 → Problem            caller does not hold (appId,"access"), or caller is soft-deleted
                           code: "app_access_required"
  429 → Problem + Retry-After   code: "rate_limited"
```

`POST`, not `GET`, so the probed email never enters a URL, an access log, or a `Referer`.

```
POST /authz/users/identities
  auth: bearerJwtMiddleware (any authenticated suite user)
  body: { ids: string[]   (1..100 entries, each 1..64 chars) }

  200 → { "users": [ { "id": "clx…", "status": "active",  "name": "Marco Rossi" },
                     { "id": "cly…", "status": "deleted", "name": null },
                     { "id": "zzz",  "status": "unknown", "name": null } ] }
  400 → Problem   empty/over-cap ids array
  401 → Problem
  429 → Problem + Retry-After
```

Accepts **ids only**. No email, no name, no prefix, no wildcard, no pagination — it cannot
enumerate. `name` is returned only for `status: "active"` (AC-10.5: never identity that
implies an inactive account is active). Emails are never returned.

### `estimai-api` — modified

```
GET /estimates                                                  (AC-2.1/2.2/2.3)
  200 → EstimateListItem[]
        EstimateListItem = {
          id, name, author, updatedAt,
          access: "owner" | "editor" | "viewer",
          owner: null                                   // when access === "owner"
               | { status: "active"|"deleted"|"unknown", name: string|null }
        }
        Rows = estimates the caller owns UNION estimates they hold a grant on,
        newest-first. [] is still the empty state, not an error.
```

```
GET /estimates/{id}                                             (AC-1.6/3.1)
  200 + ETag: "<version>" → EstimateFull
        EstimateFull = { id, name, author, content, createdAt, updatedAt,
                         version: number,
                         access: "owner"|"editor"|"viewer",
                         owner: null | { status, name },
                         collaboratorCount?: number }   // present only when access === "owner"
  404 → no relationship (absent OR neither owner nor collaborator) — indistinguishable
```

```
PUT /estimates/{id}                                             (AC-3.1/3.2, US-4)
  headers: If-Match: "<version>"      REQUIRED
  body: EstimateUpsert                unchanged from spec 001
  200 + ETag: "<new version>" → EstimateFull
  400 → validation
  428 → { …, code: "precondition_required",
          detail: "This save needs an If-Match precondition. Reload the estimate." }
  413 → size guard (unchanged, ADR-0004)
  403 → { …, code: "insufficient_access",
          detail: "You have view-only access to this estimate." }        (viewer, AC-3.1)
  404 → no relationship
  409 → { type, title: "Conflict", status: 409, detail, instance,
          code: "estimate_version_conflict",
          currentVersion: 12,
          updatedAt: "2026-08-07T09:12:04.221Z",
          lastModifiedBy: { status: "active"|"deleted"|"unknown", name: string|null } }
        ── AC-4.1/4.3/4.4. Nothing is written. `lastModifiedBy` is best-effort
           (identity resolution failure → status "unknown"), never blocks the 409.
  Evaluation order: 401 → 400 → 428 → 413 → 404/403 → 409.
  (Access precedes the version check so a stranger's probe can never elicit a 409.)
```

```
DELETE /estimates/{id}                                          (AC-3.3, AC-9.1, AC-10.4)
  204 → deleted; all EstimateCollaborator rows cascade
  403 → { …, code: "owner_only" }   caller is a collaborator
  404 → no relationship
```

### `estimai-api` — new (all under the existing `estimatesRouter`, jwtMiddleware + 2 MiB bodyLimit)

```
GET /estimates/{id}/collaborators                               (owner only)
  200 → { collaborators: [ { id, email, accessLevel, createdAt,
                             identity: { status, name } } ] }
        `id` is the GRANT's id, never the collaborator's `sub` — user ids are not
        put into URLs or list payloads.
  403 → code: "owner_only"     caller is a collaborator (deliberate: the list is
                               owner-only; the spec never grants collaborators
                               visibility of each other, so we disclose nothing)
  404 → no relationship
```

```
POST /estimates/{id}/collaborators                              (owner only, US-1)
  body: { email: string, accessLevel: "viewer" | "editor" }
  201 → { id, email, accessLevel, createdAt, identity }
  400 → malformed email / bad accessLevel                    code: "invalid_input"
  403 → caller is a collaborator (AC-1.5)                    code: "owner_only"
  404 → no relationship
  409 → already a collaborator (AC-1.3)                      code: "already_collaborator"
        detail names the existing level and points at PATCH
  422 → sharing with yourself (AC-1.4)                       code: "cannot_share_with_self"
  422 → THE GENERIC REJECTION (AC-1.2)                       code: "collaborator_not_eligible"
        detail: "That address can't be added as a collaborator. Collaborators must be
                 Operai users who already have EstimAI access."
        ── ONE fixed status, ONE fixed code, ONE fixed detail string, floored to
           SHARE_LOOKUP_FLOOR_MS, for BOTH AC-1.2 causes. No variant, ever.
  429 → code: "rate_limited"  + Retry-After
  503 → auth unreachable (fail closed)   code: "authorization_service_unavailable"

  Handler order:
    1. resolveAccess → 404 / 403 (owner_only)
    2. rate limiter (counts EVERY attempt)                    → 429
    3. normalise email (trim + lower-case); syntax            → 400
    4. fast self-check against the caller's JWT `email` claim  → 422 self
    5. duplicate check on (estimateId, email)                  → 409
    6. auth POST /authz/app-access-check { appId:"estimai", email }
         throw/non-2xx → 503;  eligible:false → floored 422 generic
    7. definitive self-check: resolved userId === caller `sub` → 422 self
       (catches an alias address the fast check misses)
    8. INSERT; unique-violation on (estimateId,userId)         → 409 already_collaborator
       (an email-snapshot mismatch cannot create a duplicate grant)
    9. after commit, best-effort notify (AC-7.1)
```

```
PATCH /estimates/{id}/collaborators/{collaboratorId}            (owner only, AC-5.1)
  body: { accessLevel: "viewer" | "editor" }
  200 → { id, email, accessLevel, createdAt, identity }
  403 → code: "owner_only"        404 → estimate or grant not found
  No notification (AC-7.3). Takes effect on the collaborator's next request (AC-5.3).

DELETE /estimates/{id}/collaborators/{collaboratorId}           (owner only, AC-5.2)
  204 → grant removed; best-effort removal notification (AC-7.2)
  403 → code: "owner_only"        404 → estimate or grant not found

DELETE /estimates/{id}/collaborators/me                         (self, US-6)
  204 → the caller's OWN grant removed; NO notification (AC-7.2 excludes self-leave)
  404 → code: "not_a_collaborator"   — includes the owner (AC-6.2: an owner has no
        grant to leave; they delete the estimate instead)
  Route registration order: the literal `/me` is registered BEFORE the
  `{collaboratorId}` param route.
```

### New environment variables

| Service | Var | Purpose |
|---|---|---|
| `estimai-api` | `AUTH_BASE_URL` | base for `POST /authz/app-access-check` + `/authz/users/identities` |
| `estimai-api` | `NOTIFY_INTERNAL_URL` | `notify-api` internal base |
| `estimai-api` | `NOTIFY_INTERNAL_TOKEN` | `X-Internal-Token`, ≥32 chars, identical to `auth`/`refund-api`/`notify-api` |
| `estimai-api` | `SHARE_LOOKUP_FLOOR_MS` | default `300` — AC-1.2 response floor |
| `estimai-api` | `SHARE_ADD_RATE_LIMIT` / `_WINDOW_MS` | default `20` / `600000` |
| `auth` | `APP_ACCESS_CHECK_FLOOR_MS` | default `150` |
| `auth` | `APP_ACCESS_CHECK_RATE_LIMIT` / `_WINDOW_MS` | default `40` / `600000` |

All validated at startup (`process.exit(1)` on missing), per CLAUDE.md.

## Test strategy

Tooling: `bun test` for `estimai-api` and `auth` (integration against the compose Postgres;
JWTs signed in-test with a fixture RS256 keypair; `mock.module()` on the single-function
`authClient`/`notify` modules — the established pattern from `refund-api`, chosen precisely
because re-mocking `jose` collides across test files in one bun worker). `estimai-ui`:
Vitest + Testing Library; Playwright for the two-user e2e flows.

**AC → test coverage (total — all 33 ACs mapped).**

| AC | What it asserts | Level | Test that proves it |
|---|---|---|---|
| AC-1.1 | Eligible email + level → collaborator created and listed | integration (api) | `POST /estimates/{id}/collaborators` with `app-access-check` mocked `eligible:true` → 201; `GET …/collaborators` contains the row; the target's `GET /estimates` now includes the estimate |
| AC-1.2 | Both ineligible causes → ONE fixed message/status/timing; no email sent | integration (api + auth) | (a) `auth`: no-such-user and user-without-`estimai:access` both → `{eligible:false}`, byte-identical body; (b) `estimai-api`: both → 422 `collaborator_not_eligible`, identical `detail`; (c) timing: 50 samples per cause, both medians ≥ floor and differing < 10% of floor; (d) assert the `notify` module is never called on this path |
| AC-1.3 | Duplicate → distinct "already a collaborator" message, no dup row | integration (api) | Add twice → 409 `already_collaborator`; row count stays 1. Second case: stale email snapshot → the `(estimateId,userId)` unique violation also maps to 409 |
| AC-1.4 | Owner cannot add themselves | integration (api) | (a) own JWT email → 422 `cannot_share_with_self` without any `auth` call; (b) alias email resolving to the caller's own `sub` → same 422, proving the post-lookup check |
| AC-1.5 | A collaborator cannot add collaborators (API-level) | integration (api) | Editor's JWT → `POST …/collaborators` → 403 `owner_only`; no row created |
| AC-1.6 | An unrelated user gets 404, not 403 | integration (api) | Third user's JWT → `GET/PUT/DELETE /estimates/{id}` and all `…/collaborators` routes → 404, Problem body identical to a genuinely absent id |
| AC-2.1 | Shared estimates appear in the collaborator's list with owner + own level | integration (api) + unit (ui) | api: `GET /estimates` returns the shared row with `access:"viewer"` and `owner.name`; ui: `EstimatesPage` renders owner label + level chip |
| AC-2.2 | Owned vs shared visually distinguishable | unit (ui) | List with one owned + one shared → shared row has the "Shared" indicator, owned row does not (queried by role/testid, not by class) |
| AC-2.3 | Zero owned + ≥1 shared → not the empty state | unit (ui) + integration (api) | api: `GET /estimates` for a user with only grants → non-empty; ui: that list renders rows, and the "Ready to estimate your first project?" empty state is absent |
| AC-3.1 | Viewer: identical computed values, export/link-share work, edits refused in UI and API | unit (ui) + integration (api) | ui: mount as viewer → `useEstimator` outputs deep-equal the owner's; every add/edit/delete control is absent or `disabled`; link-share + XLSX/PDF actions still enabled. api: viewer's `PUT` → 403 `insufficient_access`, stored row byte-identical afterwards |
| AC-3.2 | Editor has the owner's content-editing capabilities | integration (api) + unit (ui) | api: editor `PUT` (valid `If-Match`) → 200, version incremented, content persisted incl. `name`; ui: mount as editor → mutating controls enabled |
| AC-3.3 | No collaborator may delete the estimate or manage collaborators | integration (api) | Viewer AND editor: `DELETE /estimates/{id}` → 403 `owner_only`; `POST`/`PATCH`/`DELETE …/collaborators/{id}` → 403; estimate + grants unchanged |
| AC-4.1 | Stale save refused, nothing overwritten, clear conflict | integration (api) + unit (ui) | api: A saves (v1→v2); B `PUT` with `If-Match:"1"` → 409 with `currentVersion:2`; stored content still A's. ui: `update` rejects with `ConflictError` → `ConflictBanner` renders |
| AC-4.2 | Reload offered; in-progress edits survive until the user reloads | unit (ui) | On 409: local `acts/params/name` unchanged, editor still shows them, a "Reload latest" action is present, and no route invalidation fired automatically |
| AC-4.3 | Two simultaneous saves → exactly one wins | integration (api) | Fire two `PUT`s with the same `If-Match` concurrently (`Promise.all`) → exactly one 200 and one 409; final `version` incremented by exactly 1; content equals the winner's |
| AC-4.4 | Same detection for a solo owner's two tabs | integration (api) + e2e | Same owner JWT, two `If-Match:"1"` saves → second 409. e2e: two browser contexts, same user, second tab's autosave surfaces the conflict banner |
| AC-5.1 | Level change takes effect on the next request | integration (api) | editor→viewer `PATCH` → the collaborator's next `PUT` → 403; viewer→editor → next `PUT` → 200 |
| AC-5.2 | Removal → same refusal as an unrelated user; gone from their list | integration (api) | `DELETE …/collaborators/{id}` → former collaborator's `GET /estimates` excludes it and `GET /estimates/{id}` → **404** (identical body to AC-1.6's) |
| AC-5.3 | No live disconnection; enforcement is next-request | integration (api) | Revoke while a prior `GET` response is already held → no push/stream involvement asserted (no SSE subscription exists for estimates); the next `PUT` is the first refusal |
| AC-5.4 | The owner is never listed or manageable as a collaborator | integration (api) | `GET …/collaborators` never contains the owner's grant (none can exist — AC-1.4); `PATCH`/`DELETE` on a fabricated owner grant id → 404 |
| AC-6.1 | A collaborator can remove themselves | integration (api) | `DELETE …/collaborators/me` as viewer → 204; their `GET /estimates` excludes it; owner's `GET …/collaborators` no longer lists them |
| AC-6.2 | No leave for the owner | integration (api) + unit (ui) | api: owner's `DELETE …/collaborators/me` → 404 `not_a_collaborator`; ui: no Leave affordance when `access === "owner"` |
| AC-7.1 | Grant → in-app notification naming estimate + level | integration (api) | `POST …/collaborators` → the mocked notify client called once with `recipientId` = target `sub`, `originApp:"estimai"`, body containing the estimate name + level, `link.href:"/estimai/estimates/{id}"` |
| AC-7.2 | Owner-initiated removal notifies; self-leave does not | integration (api) | Owner `DELETE …/collaborators/{id}` → notify called once, no link; `DELETE …/collaborators/me` → notify **not** called |
| AC-7.3 | No notification for edits/saves/exports/level changes | integration (api) | `PUT /estimates/{id}` (owner and editor) and `PATCH …/collaborators/{id}` → notify client never called |
| AC-8.1 | Existing link share unchanged | unit (ui) + contract | `shareUrl.buildShareUrl` + `SharedEstimatePage` snapshot/behaviour tests unchanged and still green; a contract test asserts `SharedEstimatePage` performs **no** `apiFetch` call |
| AC-8.2 | Link-share view shows no collaborator UI | unit (ui) | Render `SharedEstimatePage` with a `#data=` payload → no collaborator list, no level chip, no "Shared with you" text; only the existing plain `author` field |
| AC-9.1 | Deleting an estimate deletes every grant | integration (api) | Estimate with 2 grants → owner `DELETE` → `estimate_collaborator` count for that id = 0; both former collaborators' `GET /estimates` exclude it and `GET /estimates/{id}` → 404 |
| AC-10.1 | Owner soft-delete leaves estimate + grants untouched | integration (cross-service) | Seed estimate + grants; run `auth`'s soft-delete path for the owner; assert the `estimate` row and every `estimate_collaborator` row are byte-identical (no writes, no delete-time call into `estimai-api` — asserted by a network spy) |
| AC-10.2 | Editor keeps editing an orphaned estimate | integration (api) | After the owner is soft-deleted: editor `GET` → 200, `PUT` (valid `If-Match`) → 200 |
| AC-10.3 | Viewer keeps viewing an orphaned estimate | integration (api) | After soft-delete: viewer `GET` → 200 with identical `content` |
| AC-10.4 | Owner-only operations permanently unavailable | integration (api) | After soft-delete: every remaining collaborator (viewer and editor) gets 403 `owner_only` on `DELETE /estimates/{id}` and on all collaborator-management routes; no route exists that reassigns ownership (route-table assertion) |
| AC-10.5 | Deleted owner renders a clear placeholder, never blank/raw/stale | integration (api) + unit (ui) | api: `GET /estimates` for the collaborator → `owner:{status:"deleted", name:null}`. ui: that row renders "Former wellD member"; a separate case with `status:"unknown"` renders the neutral placeholder and neither renders a raw cuid, a blank, nor an error |

**Additional non-AC tests the design demands** (defects these would catch are invisible to
the AC table):

- **Anti-enumeration contract test** (`auth`): a snapshot of the `eligible:false` response
  body asserting it has exactly one key. Any future field addition breaks the test — this is
  the tripwire that keeps AC-1.2 true over time.
- **Directory-shape contract test** (`auth`): `POST /authz/users/identities` rejects a body
  containing `email`, `name`, `query`, or `prefix`, and rejects >100 ids. Guards the
  Non-goal boundary.
- **Mutual-exclusion test** (`estimai-api`): the collaborator routes reject
  `X-Internal-Token` and accept only a user JWT (ADR-0011's invariant, extended to the third
  token holder); and `estimai-api` never exposes a `/system/*` route.
- **Rate-limit test**: the 21st add attempt in the window → 429; the counter increments on
  successes and on 409/422 alike.
- **CAS-predicate test**: a viewer's `PUT` with a *correct* `If-Match` still fails — proving
  the access predicate, not the version, is what stopped it (a `403` must not be reachable
  via the version branch and vice versa).
- **Fail-closed test**: `app-access-check` throwing → `POST …/collaborators` returns 503,
  never a silent allow, and no grant row is created.
- **Fail-soft test**: `/authz/users/identities` throwing → `GET /estimates` still returns
  200 with `owner.status:"unknown"`.
- **Autosave-suppression test** (ui): after a 409, advancing timers by 10× the debounce
  fires **no** further `PUT` (retry-storm regression).

## Risks

- **R1 — The endpoint is an enumeration oracle by construction; timing can only be
  bounded, not eliminated.** Even after the fixed floor and the equalised work path, a
  determined attacker with a large sample could in principle detect a sub-jitter signal.
  *Mitigation:* decision-not-fact response (the strongest control — there is no fact to
  leak from the source), equalised query shape, dual floors, per-caller rate limiting, and
  the caller gate (only holders of `estimai:access` can ask). *Residual, accepted:* what an
  authorised employee can learn is "colleague X does/doesn't have EstimAI access" — inside a
  company where they could learn the same by asking. *Early check:* the timing test in the
  AC-1.2 row runs in CI on the first slice of this feature, before the UI exists.
- **R2 — `If-Match` becomes mandatory; browser tabs loaded before the rollout break.**
  Their next autosave 428s. *Mitigation:* map 428 to the same "Reload latest" banner as 409 —
  one click and the tab is healthy; ship `estimai-api` and `estimai-ui` in the same release
  window. *Early check:* an e2e that loads the editor, simulates a version-less client, and
  asserts the banner (not a silent failure and not a clobber).
- **R3 — `auth` availability now gates *adding* a collaborator (503, fail-closed).**
  *Mitigation:* the blast radius is deliberately confined to that one path — reads, saves,
  deletes, and the whole editor keep working during an `auth` outage, unlike `refund-api`
  (ADR-0014). *Do not "fix" this by making the share path fail open.*
- **R4 — ADR-0012's residual-JWT window vs. AC-10.4's "permanently unavailable".** A
  just-soft-deleted owner's already-issued JWT keeps verifying at `estimai-api` until it
  expires, so for that bounded window they could still delete their estimate or change
  grants. This is ADR-0012's explicitly accepted, suite-wide trade-off, not a new gap, and
  closing it means the resource-server liveness check ADR-0012 named as its escalation path.
  *Recorded, not re-litigated here.*
- **R5 — Read-only gating is spread across many components; one missed control lets a viewer
  *appear* to edit.** No data is at risk (the server returns 403), but the UX would be
  broken. *Mitigation:* a single `canEdit` from context, no per-component logic, plus a test
  that mounts the editor as a viewer and asserts **no** enabled mutating control anywhere in
  the tree. *Early check:* that test lands with the first UI slice.
- **R6 — Notification delivery is best-effort (ADR-0017).** A `notify-api` outage silently
  drops a grant notification. *Mitigation:* the grant itself is authoritative — the
  collaborator sees the estimate on their next list load regardless (AC-7.1's push is
  additive). Failures are logged.
- **R7 — In-process rate limiters and identity caches are per-instance.** Horizontally
  scaling `estimai-api` or `auth` would multiply the effective rate limit by the replica
  count. *Mitigation:* both run single-instance today; the limiter module is written behind
  one interface so a shared store is a swap, not a rewrite. *Early check:* deployment task
  asserts instance count = 1 (the same constraint `notify-api` already carries for SSE).
- **R8 — `updateMany` with a relation filter (`collaborators: { some: … }`) in the CAS
  predicate.** Prisma compiles this to a subquery; if the generated SQL proves unusable, the
  fallback is a `$executeRaw` CAS with an explicit `EXISTS`. *Early check:* the very first
  api slice asserts the CAS behaviour (AC-4.3's concurrent test) — a failure surfaces
  immediately, not at integration.
- **R9 — Estimate names now leave `estimai-api` and land in `notify-api`'s database.** Names
  can identify a client. *Mitigation:* both services are EU-region; truncated to 120 chars;
  content is never sent. Recorded as a deliberate widening, not an oversight.
- **R10 — Grant removal leaves no trace.** The spec's Non-goals exclude an audit/history
  log, so "who had access when" is unrecoverable after a removal or an estimate deletion.
  *Accepted per spec*, flagged so it is not later discovered as a compliance surprise.

## Security

**SECURITY-SENSITIVE? — YES**, and at the elevated tier. This feature (a) makes one user's
data readable and writable by another for the first time in EstimAI, (b) adds a
by-email third-party lookup that is an enumeration oracle by construction, (c) adds a third
holder of a static cross-service shared secret, and (d) widens every access predicate in a
service whose data is client-sensitive commercial information for regulated-sector clients
(energy/finance/healthcare, CLAUDE.md). Per the process, the orchestrator schedules an
**`owasp-reviewer` pass in parallel with QE**, at the frontier tier.

Named surfaces for the review, in priority order:

1. **`auth POST /authz/app-access-check`** (A01/A04/A09). Confirm: the negative response has
   exactly one key on every path; soft-deleted targets are `eligible:false`; the caller gate
   (`(appId,"access")` + caller not soft-deleted) cannot be bypassed by a crafted `appId`;
   the floor and the sentinel-resolve both actually execute; the probed email never reaches
   a log line; the rate limiter counts every outcome.
2. **`estimai-api POST /estimates/{id}/collaborators`** (A01). Confirm the handler order
   above is what ships — in particular that `resolveAccess` (404/403) precedes the rate
   limiter and the lookup, that `grantedByUserId`/`userId` come only from the verified JWT
   and the auth response (never from the body), and that the 422 detail string is a single
   constant with no interpolation.
3. **Access predicates in `estimai-api/src/estimates/estimates.repo.ts` + `access.ts`**
   (A01, IDOR). Every read and write predicate must be `owner OR grant`, derived from the
   verified `sub`; the `PUT` CAS must carry the access predicate *inside* the single
   statement; `DELETE` must stay owner-only; the 403/404 split must match the taxonomy above
   with no path where a stranger elicits a 403 or a 409.
4. **`POST /authz/users/identities`** (A01/excessive data exposure). Confirm it takes ids
   only, caps at 100, returns no email, and returns `name` only for active users.
5. **`estimai-api` → `notify-api` trust edge** (A02/A05). Confirm `NOTIFY_INTERNAL_TOKEN` is
   never logged, never reaches the browser, that `estimai-api` exposes no inbound
   internal-token route, and that its deployment keeps the call on private networking.
6. **Conflict/precondition handling** (A04). Confirm a 409 body never carries estimate
   content, and that `lastModifiedBy` resolution failure degrades rather than erroring.
7. **Rate limiting + DoS** (A04). Unbounded `ids` arrays, unbounded collaborator counts (no
   cap per spec — confirm the list endpoint cannot be turned into a heavy identity fan-out;
   the ≤100 batch cap and dedup must hold).

Data residency: unchanged. `estimate_collaborator` is new data owned by `estimai-api` (EU
region); the only new cross-service flows are `estimai-api ↔ auth` and `estimai-api →
notify-api`, both EU-to-EU. Logging posture unchanged: `requestLogger` emits method/path/
status only — and the new paths must never carry an email (hence `POST`, not `GET`, for the
lookup).

## ADR candidates

*(For the caller to invoke `adr-writer` — not written here.)*

1. **Third-party app-access lookup: a decision endpoint, not a fact endpoint, on the
   forwarded-caller-JWT trust model.** `auth POST /authz/app-access-check` returns a boolean
   eligibility decision so both AC-1.2 causes collapse at the source, making the
   anti-enumeration property hold even for a caller who bypasses `estimai-api`; caller-gated
   on `(appId,"access")` via the existing resolver; internal-shared-token trust explicitly
   rejected (no new secret on the identity service, and per-caller rate limiting/attribution
   would become impossible). Records the timing-mitigation mechanism (equalised work path +
   dual floors) and **the suite's first rate limiter** as the primary anti-abuse control.
   Constrains every future "ask `auth` about someone else" requirement.
2. **Record-level sharing (a per-record ACL) as a new access primitive, owned by the
   resource server.** Until now all authorization in the suite was role/department/attribute
   based and resolved in `auth` (ADR-0007/0014/0015). Per-record grants live in
   `estimai-api`'s own table, are never expressed in the catalog, and `estimai-api`
   deliberately does **not** become an authorization-enforcing resource server. Establishes
   the rule: *role/attribute rules live in `auth`; per-record grants live in the app that
   owns the record* — and that the two must not be conflated.
3. **Denial taxonomy for shared records: 403 when a relationship exists but the level is
   insufficient, 404 only when no relationship exists.** A narrowing of ADR-0005's blanket
   "not owned = 404" for a world with collaborators, aligned with ADR-0014's
   capability-vs-record split. Reusable by every future app that adds record sharing.
4. **Optimistic concurrency by integer `version` + `If-Match`/`ETag` CAS — supersedes spec
   001's / ADR-0004's last-write-wins acceptance.** Records why `updatedAt`-as-precondition
   was rejected (serialisation-granularity fragility), why `If-Match` is *required* rather
   than optional (AC-4.4 across a mixed client fleet), and that ADR-0004's persistence shape
   is otherwise untouched. This is an **amendment to ADR-0004**, and the ADR should say so.
5. **Display identity is resolved live from `auth` by id, never denormalised into a resource
   server.** `POST /authz/users/identities` is id-keyed, capped, email-free and
   non-searchable — deliberately not the user directory specs/004/006 keep admin-only; the
   `active`/`deleted`/`unknown` tri-state is what makes AC-10.5's "never stale identity
   implying an active account" achievable at all. Fails **soft** (decorative), in explicit
   contrast to the fail-**closed** authorization path in the same service.
6. **`estimai-api` becomes the third holder of `NOTIFY_INTERNAL_TOKEN` — ADR-0011's
   escalation trigger fires a second time and is again deferred, with a hard stop recorded.**
   Should state the enlarged blast radius (three services), the deployment discipline this
   imposes on `estimai-api`, and that a *fourth* internal caller or any suspected leak builds
   ADR-0011's Option C (scoped self-issued service JWTs) rather than deferring a third time.

## Spec amendment proposed

**None.** All 33 ACs are mappable and the spec is internally consistent. Two interpretations
are recorded here rather than as amendments, because each is a plan-level realisation of an
AC's intent, not a change to it:

- **AC-1.2 "timing characteristics must be identical"** is implemented, and tested, as
  *quantised to a fixed response floor over an equalised work path*, so the two causes are
  indistinguishable above measurement noise. Bit-exact timing identity is not achievable on
  a networked service; the AC's testable property (an owner cannot distinguish the causes)
  is fully met.
- **AC-10.4 "permanently unavailable to every remaining user"** is met by construction
  (owner-only operations require `userId === callerId`, and a soft-deleted owner cannot
  obtain a session). The *soft-deleted owner's own* residual JWT window remains, bounded by
  token TTL — ADR-0012's explicitly accepted suite-wide trade-off, not a new exception
  introduced here.
