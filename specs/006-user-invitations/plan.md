---
spec: 006
status: approved
---

# Plan: User invitations, resend, and user deletion

## Architecture

This feature spans **auth** (owns the invitation lifecycle, activation hooks, soft-delete +
session revocation, admin API), **notify-api** (gains a second, email-delivery channel via
Resend), and **admin-ui** (the invitation + user-deletion screens). No new service is
introduced; both endpoints and both hooks live in the existing services. It builds on
ADR-0002 (auth hosts unauthenticated entry pages), ADR-0005 (JWKS resource-server
verification), ADR-0006 (federated remotes), ADR-0007 (live RBAC/ABAC + `perm_epoch`),
ADR-0009 (notify-api standalone service + channel seam) and ADR-0010 (`aud` claim).

### Components touched / added

- **auth / `src/invitations/`** (new): invitation domain + admin API
  (`invitations.routes.ts`, `invitations.repo.ts`, `invitations.schemas.ts`), the
  invite-link token helper, and the effective-status derivation. Registered in
  `src/index.ts` under the existing admin guard chain.
- **auth / `src/admin/users.routes.ts`** (extended): `DELETE /admin/users/{id}` (single
  soft-delete), `POST /admin/users/delete` (bulk, partial-success), and filtering
  soft-deleted users out of `GET /admin/users` + `GET /admin/users/{id}`.
- **auth / `src/admin/lastAdminGuard.ts`** (extended): admin-count queries gain a
  `deletedAt: null` filter (a soft-deleted admin is not an effective admin) and the guard
  is reused for the delete path.
- **auth / `src/auth/auth.config.ts`** (extended): two `databaseHooks` — the existing
  `user.create.after` gains invitation-matching after baseline-role assignment, and a new
  `session.create.before` blocks/redirects sessions for soft-deleted users (and
  re-activates a soft-deleted user who has a fresh pending invitation).
- **auth / `src/invite/`** (new): a hosted, unauthenticated invite-landing page
  (`GET /invite`, Hono JSX, ADR-0002 precedent) plus its JSON lookup, showing the
  invitation state and routing into the existing OAuth sign-in.
- **auth / `src/lib/notify.ts`** (new): the outbound client that asks notify-api to send
  the invite/resend email over the internal channel.
- **notify-api / `src/channels/`** (new): a channel abstraction — `inApp` (existing
  behaviour, `recipientId = sub`, persist + SSE) and `email` (new, addresses a raw email,
  Resend + `EmailDelivery` log). Plus `src/system/emails.routes.ts` (the internal,
  service-token-authed send endpoint) and `src/lib/resend.ts`.
- **admin-ui**: an Invitations view within the Users section (`InvitationsPage`, invite
  modal reusing the role/department pickers, per-row Resend/Revoke), and the Users list
  gains row + bulk soft-delete with a distinct confirm step; the caller's own row omits
  delete.

### The two better-auth hook seams (open question 1)

better-auth fires `databaseHooks.user.create.after` exactly once, when a user row is first
persisted — the existing baseline-role hook already relies on this. It does **not** fire
for a returning user (better-auth matches the OAuth `account` row first and only creates a
session). Activation therefore needs two distinct seams:

1. **`user.create.after` — new-user activation (US-2, AC-2.3/2.4).** After
   `assignBaselineRolesToNewUser`, look up a **live pending** invitation for the new user's
   **verified** email: `status = 'pending' AND expiresAt > now() AND lower(email) = lower(user.email)`,
   gated on `user.emailVerified === true` (same posture as the bootstrap-admin match — the
   email comes only from the OAuth provider's verified profile, never a request body). On a
   match, in one transaction: apply the invitation's `roleIds`/`departmentIds` (upsert,
   additive to the baseline `employee` role), set `status='accepted'` +
   `acceptedByUserId`, bump `permissionEpoch`, and write an `audit_log` row. **AC-2.4** is
   satisfied structurally: the match keys on the *new user's own verified email*, never on
   the invite-link token — a different OAuth identity looks up its *own* email, finds no
   invitation, and the original stays pending. The invite-link token is UX/landing only,
   never an authorization input.
2. **`session.create.before` — soft-delete gate + re-activation (AC-5.1/5.2/5.10).** Fires
   on every session creation (every sign-in, including a returning OAuth identity whose
   account row already exists). Load `{ deletedAt, email, emailVerified }` for the
   session's user:
   - `deletedAt == null` → allow (normal path; no invitation logic — an active user's
     email can never have a pending invitation, AC-1.3).
   - `deletedAt != null` → the returning user is soft-deleted. Look for a **live pending**
     invitation for the verified email:
     - **found** → re-activate (AC-5.10): clear `deletedAt`, **replace** roles/departments
       with exactly the invitation's set (a new activation, not a resurrection of prior
       grants), bump `permissionEpoch`, mark the invitation `accepted`, audit — then allow
       the session.
     - **not found** → deny the session (AC-5.2): the sign-in is refused, the account is
       not resurrected and not treated as a new sign-up (no new user row is created because
       the account row still maps to the existing soft-deleted user).

   Denial returns a `false`/abort from the before-hook so no session persists; the OAuth
   callback lands back on the hosted sign-in page with an "account inactive — contact an
   admin" notice. (better-auth 1.6.2's exact abort contract for `session.create.before` is
   pinned as risk R1.)

Keeping the account + user rows on soft-delete is deliberate: it makes a re-OAuth map back
to the *same* soft-deleted user (so the gate/re-activation applies) instead of spawning a
fresh `employee` user via `user.create.after`.

### notify-api email channel + the cross-service trigger (open question 2)

**Ownership split:** auth owns the invitation record and *decides when* an email is due;
notify-api owns *delivery* (Resend, templates, the delivery log). notify-api stays
invitation-agnostic — it exposes a generic email channel, matching the constraint "a
second delivery channel alongside its in-app/SSE channel." auth calls notify-api
synchronously from the invite-create / resend handler; the email is data-in, not
invitation-logic-in.

**Channel abstraction (sub-problem b):** notify-api's `channels/` gains two implementations
behind a small internal interface. `inApp` is today's behaviour — addresses a `sub`,
persists a `Notification`, publishes to SSE. `email` addresses a **raw email address**,
renders a template, sends via Resend, and records an `EmailDelivery` row. The existing
`POST /notifications` (user-JWT) uses `inApp` unchanged; the new internal endpoint uses
`email`. The address-vs-sub split lives entirely in the channel layer, so neither channel
leaks the other's addressing model.

**Service-to-service auth (sub-problem a) — decision:** a **dedicated internal endpoint
(`POST /system/emails`) authenticated by a strong shared service token**
(`NOTIFY_INTERNAL_TOKEN`, 1Password-sourced), mounted on its own router with an
`internalTokenMiddleware` that is *not* `jwtMiddleware`. The user-JWT routes never accept
the service token, and `/system/*` never accepts a user JWT. Rationale and rejected
alternatives:
- *Rejected — forward the admin's end-user JWT.* The recipient is a third-party email, not
  the admin's `sub`; notify's whole in-app model derives recipient from `sub`. Forwarding
  the admin token conflates the admin's identity with a system send and would let any
  admin-scoped token reach the email surface. Wrong trust semantics.
- *Rejected (documented as ADR alternative) — auth self-issues a scoped service JWT
  (`sub="system:auth"`, dedicated `aud`, `scope="email.send"`) verified via the existing
  JWKS.* Elegant (no new secret, reuses ADR-0010 audience scoping) but forces a second
  audience path and a scope assertion into notify's verifier, and notify's current
  middleware hard-requires an `email` claim + `sub`-as-recipient — a system token fits
  neither, so a separate route is needed *anyway*. The shared-token route is then the
  lower-coupling choice.
- **Trade-off (must be recorded):** the entire trust boundary is "only auth holds the
  token." A leaked token = arbitrary email to arbitrary addresses over wellD's Resend
  domain (phishing). Mitigations: internal-network-only exposure (Railway private
  networking, not public ingress), strong random token in 1Password, never logged, and the
  endpoint carries no reply-to/HTML-injection surface (fixed bilingual templates, the only
  variable inputs are `to`, `inviteUrl`, `inviterName`, `expiresAt`, all escaped). See risk
  R2. This is an ADR candidate.

**Resend + i18n + failure (sub-problem c):** `RESEND_API_KEY` + `RESEND_FROM`
(`no-reply@operai.welld.io`) via env/1Password. Templates are **bilingual (IT + EN in one
email)** — the invitee has no user row and thus no locale preference, and AC-2.1 requires
the email be "offered in both Italian and English"; a single bilingual message satisfies it
without guessing a locale. The email body carries no client/estimate PII — only the
invitee's own address, the invite link, the inviter's name, and the expiry — so
data-residency exposure is minimal (invitation data at rest stays in EU Postgres on Railway
EU; Resend is the transactional MTA, use its EU sending region if available). **Failure
handling:** the invitation is created/committed first; the email send is then attempted. On
Resend/network failure notify-api records `EmailDelivery.status='failed'` and returns that
status; auth stores `Invitation.lastEmailStatus='failed'` (+ `lastEmailError`) and returns
`201` with a `emailDelivery: "failed"` field. The admin observably sees "invitation created
but email failed — resend" (surfaced in the invite modal result and the list row). There is
**no background retry queue** — admin-driven **resend** (US-3) *is* the retry path, which
matches the product model.

### Soft-delete + session-revocation flow (open question 3)

On `DELETE /admin/users/{id}` (and per-user inside bulk), in one `withAudit` transaction:
1. Guard `caller.id !== targetId` (AC-5.6, absolute) → else `422`.
2. Last-admin guard (AC-5.5): reuse `assertNotRemovingLastAdmin` with
   `isCurrentlyAdmin = target-is-admin`, `willBeAdminAfter = false` — refuse `422` if it
   would leave zero *active* admins (the guard's admin-count queries now filter
   `deletedAt: null`).
3. `user.update` → set `deletedAt = now()`, `deletedByUserId = caller.id`.
4. `session.deleteMany({ userId })` — **synchronous** session revocation (AC-5.1).
5. `perm_epoch` bump + `audit_log` row (`action: "user.delete"`, AC-5.8), via `withAudit`.
Retained deliberately: the `user` row, its `account` rows (so re-OAuth maps back and is
gated), its `user_role`/`user_department` rows (inert while `deletedAt` set; reset on any
re-activation), and all cross-service data.

**Cross-service cascade — what it concretely touches:** *nothing, at delete time, in
estimai-api or notify-api.* The cascade's job is "revoke access + retain data" (spec
Constraints / Non-goals), not delete estimates or notifications. Access is cut at the
source: no session ⇒ the SPA cannot mint or refresh a JWT, and `session.create.before`
blocks re-sign-in. estimai-api/notify-api need no delete-time call and no schema change;
the deleted user's estimates/notifications are retained untouched (AC-5.4).

**The existing-JWT residual window (explicit reasoning, do-not-over-engineer):** resource
servers verify a 7-day RS256 JWT statelessly (ADR-0005) and do **not** know a user was just
deleted until the token expires. A user actively holding a valid in-memory JWT (ADR-0001:
in-memory only, lost on reload/tab-close) could keep calling estimai-api/notify-api on
endpoints that don't 401 until the token expires. **Decision: this residual window is
accepted and documented, not engineered away in v1,** because (a) AC-5.1's revocation
requirement is about *sessions*, which are killed synchronously; (b) the moment the SPA hits
any 401 or reloads, `apiFetch`'s refresh-retry (ADR-0001) fails against the deleted session
and redirects to sign-in, which is blocked — so in practice lock-out is near-immediate; and
(c) mandating a live active-user/epoch check on every resource-server request would couple
every service to auth on every call, defeating the stateless-JWT design ADR-0005 chose, for
a threat (a just-deleted insider racing their own token expiry) that is low. A future
hardening — a lightweight `sub`/epoch liveness check at resource servers, or shortening JWT
TTL — is named as an ADR candidate for the user to escalate if the regulated-data posture
demands it; it is **not** built here.

### Invitation lifecycle & expiry model

`Invitation.status` is stored as `{pending, accepted, revoked}`; **`expired` is a derived
state**, never a distinct stored value in the hot path: effective status =
`status=='pending' && expiresAt<=now ? 'expired' : status`. This avoids a scheduler (US-4:
"no admin action required"). Reconciliation:
- **List / detail / landing** compute effective status (AC-4.2 shows `expired`).
- **The matching hook** filters `status='pending' AND expiresAt>now` — a lazily-expired row
  is excluded ⇒ treated as expired (AC-4.3/AC-2.5).
- **A `pending` partial-unique index** on `email` enforces "at most one live pending per
  email" (AC-1.4); at invite-create, the transaction first flips any past-expiry
  `status='pending'` rows for that email to physical `status='expired'` (reconcile-on-write)
  before inserting, so the index never blocks a legitimately fresh invitation for an
  address whose prior invitation is dead (AC-1.5/AC-1.14).
- **Resend** (AC-3.1/3.3): on a specific invitation whose effective status ∈
  {pending, expired}, set `status='pending'`, **rotate the token** (new `tokenHash` — the
  old link's token no longer matches ⇒ AC-3.3), set `expiresAt = now()+72h`, update
  `invitedByUserId`, re-send. Refused `422` if accepted/revoked (AC-3.4).
- **Revoke** (AC-1.9): effective status ∈ {pending, expired} → `status='revoked'` (token
  invalidated immediately). Refused `422` if accepted/revoked (AC-1.10/1.11).

### Invite link & landing (US-2)

Link = `<BETTER_AUTH_URL>/invite?id=<invId>&token=<raw>`. `GET /invite` (public, ADR-0002
hosted page) hashes the token, looks up the invitation by id, and renders effective state:
`pending`+match → bilingual "you've been invited, continue with Google/GitHub" wired to the
existing `POST /auth/sign-in/social` with a `callbackURL` to the app home; `expired` /
`revoked` / `accepted` / token-mismatch (old link post-resend) → the AC-2.5 "no longer
valid" message (with the safe-to-disclose reason). The token grants no access — it only
gates the *landing view* and prefills the expected email; activation is strictly the
verified-email match at the hook.

### Sequence sketches

Invite → email → OAuth-accept → provisioned:
```
admin ──POST /admin/invitations {email,roleIds,deptIds}──▶ auth
  auth: tx{ reconcile-expired; insert invitation(pending, token, +72h); audit }
  auth ──POST /system/emails {to,inviteUrl,inviterName,expiresAt} (X-Internal-Token)──▶ notify-api
      notify-api: render bilingual template ─▶ Resend ─▶ EmailDelivery(sent|failed)
  auth ◀── {status}; store lastEmailStatus; 201 InvitationDetail
invitee ──click link──▶ auth GET /invite (token ok, pending) ─▶ "Continue with Google"
invitee ──OAuth (matching verified email)──▶ auth
  user.create.after: match live-pending invite by verified email
     ─▶ tx{ apply roles/depts; invite=accepted; perm_epoch++; audit } ─▶ lands in app WITH access
```
Soft-delete → revoke → blocked re-sign-in:
```
admin ──DELETE /admin/users/{id}──▶ auth
  guards: caller≠target; ≥1 active admin remains
  tx{ user.deletedAt=now; session.deleteMany(userId); perm_epoch++; audit(user.delete) } ─▶ 200
(user's in-memory JWT works until expiry / first 401 → refresh fails → redirect → blocked)
soft-deleted user ──OAuth again (same verified email)──▶ auth
  session.create.before: deletedAt set, no live-pending invite ─▶ deny ─▶ sign-in refused
```

### New environment variables

- **auth**: `NOTIFY_INTERNAL_URL` (notify-api base for `/system/emails`), `NOTIFY_INTERNAL_TOKEN`
  (shared service token). Invite-link base reuses `BETTER_AUTH_URL`; post-accept redirect reuses `UI_HOME_URL`.
- **notify-api**: `NOTIFY_INTERNAL_TOKEN` (same value; validates `/system/emails`),
  `RESEND_API_KEY`, `RESEND_FROM`. Optional `EMAIL_ENABLED` (default off in `test`/local
  without a key → the email channel stubs the send and records `EmailDelivery` as `sent`
  with a synthetic id).

## Data model

### auth — new `Invitation` (Prisma)

```prisma
model Invitation {
  id               String   @id @default(cuid())
  email            String                       // normalized lower-case
  status           String   @default("pending") // pending | accepted | revoked (expired = derived)
  roleIds          String[]                      // assigned-at-invite-time role ids (validated at create)
  departmentIds    String[]                      // assigned-at-invite-time department ids
  tokenHash        String                        // sha256(raw link token); rotated on resend
  expiresAt        DateTime                      // created/last-resend + 72h
  invitedByUserId  String?
  invitedBy        User?    @relation("InvitationInviter",  fields: [invitedByUserId],  references: [id], onDelete: SetNull)
  acceptedByUserId String?
  acceptedBy       User?    @relation("InvitationAcceptor", fields: [acceptedByUserId], references: [id], onDelete: SetNull)
  lastEmailStatus  String?                       // sent | failed
  lastEmailError   String?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  @@index([email])
  @@index([status])
  @@map("invitation")
}
```
Plus a **partial unique index** added in the migration SQL (Prisma cannot express it):
`CREATE UNIQUE INDEX invitation_pending_email_key ON invitation (email) WHERE status = 'pending';`

`roleIds`/`departmentIds` are Postgres `text[]` (matches the `String[]` precedent in the
codebase, e.g. `CatalogAction.supportedConditions`); existence is validated at create
(`422` on unknown id). At apply time, ids that no longer exist (a role deleted meanwhile)
are skipped with an audit note — acceptable because system roles can't be deleted and the
assignment is immutable post-create (Non-goal: no in-place edit). Join tables were
considered and rejected as over-structured for an immutable, small id list.

### auth — `User` soft-delete columns

```prisma
model User {
  // …existing…
  deletedAt        DateTime?           // null = active; set = soft-deleted
  deletedByUserId  String?             // audit convenience (also in audit_log)
  invitationsSent     Invitation[] @relation("InvitationInviter")
  invitationsAccepted Invitation[] @relation("InvitationAcceptor")
  @@index([deletedAt])
}
```

### notify-api — new `EmailDelivery` (Prisma)

```prisma
model EmailDelivery {
  id         String   @id @default(cuid())
  to         String
  template   String   // "invitation" | "invitation_resend"
  status     String   // queued | sent | failed
  providerId String?  // Resend message id
  error      String?
  createdAt  DateTime @default(now())
  @@index([to, createdAt(sort: Desc)])
  @@map("email_delivery")
}
```

### Migrations

Additive only, never editing existing migration files:
- auth: one `prisma migrate dev` migration adding `invitation` (+ the manual partial-unique
  SQL appended to the *new* file) and the `user.deletedAt`/`deletedByUserId` columns +
  index. `deletedAt` nullable with no default → zero backfill, safe on the live `user`
  table (existing rows read as active). See risk R7.
- notify-api: one migration adding `email_delivery`.

## API contracts

RFC 7807 Problem JSON for errors, ISO 8601 timestamps. Admin routes reuse the existing
`sessionMiddleware + requireAuth + requireAdmin` chain (401/403 identical to specs/004).
Wire conventions follow the existing admin API: **paginated `{items,page,pageSize,total}`**
lists, plain-object POST create bodies, **named-wrapper** bodies for set-style operations.

### Invitation admin API (auth)

`POST /admin/invitations`
```jsonc
// request
{ "email": "alice@welld.ch", "roleIds": ["r_1"], "departmentIds": ["d_2"] } // roles/depts optional
// 201
{ "id":"inv_1","email":"alice@welld.ch","status":"pending",
  "roles":[{"id":"r_1","name":"accounting"}],"departments":[{"id":"d_2","name":"Finance"}],
  "invitedBy":{"id":"u_9","name":"Admin","email":"admin@welld.ch"},
  "invitedAt":"2026-07-13T10:00:00Z","expiresAt":"2026-07-16T10:00:00Z",
  "acceptedAt":null,"emailDelivery":"sent" }
```
Errors: `400` (missing/invalid email), `409` active user exists for email (AC-1.3) /
live-pending invitation exists (AC-1.4, detail points at it), `422` unknown role/department
id, `401`/`403`.

`GET /admin/invitations?page&pageSize&status?&q?` → `200 {items:[InvitationListItem],page,pageSize,total}`.
`status` filters on **effective** status (incl. `expired`); `q` substring-matches email.

`POST /admin/invitations/{id}/resend` → `200 InvitationDetail` (fresh token/expiry,
`emailDelivery` field). Errors: `404`, `422` (effective status accepted/revoked — AC-3.4),
`401`/`403`.

`POST /admin/invitations/{id}/revoke` → `200 InvitationDetail` (`status:"revoked"`).
Errors: `404`, `422` (effective status accepted/revoked — AC-1.10/1.11), `401`/`403`.

### Invite landing (auth, public)

`GET /invite?id&token` → HTML (bilingual). JSON seam `GET /invite/state?id&token` →
`{ "state":"pending"|"expired"|"revoked"|"accepted"|"invalid", "email":"alice@welld.ch"|null }`
(email only on a valid pending token). No auth. Rate-limit-friendly, no enumeration beyond
holder-of-link.

### User deletion (auth)

`DELETE /admin/users/{id}` → `200 {"id":"u_3","deletedAt":"2026-07-13T…Z"}`.
Errors: `404` (no such *active* user), `422` self-delete (AC-5.6) / last-admin (AC-5.5),
`401`/`403`.

`POST /admin/users/delete` (bulk)
```jsonc
// request
{ "userIds": ["u_3","u_4","u_self","u_admin2"] }
// 200 — partial success is the success shape (AC-6.3)
{ "deleted":["u_3","u_4"],
  "skipped":[{"userId":"u_self","reason":"cannot delete your own account"},
             {"userId":"u_admin2","reason":"last remaining admin"}] }
```
Each deletion runs in its own `withAudit` transaction and is individually audited (AC-6.4);
the last-admin guard is evaluated *live* per user so the batch can delete one of two admins
but skips the one that would become last. `400` on empty `userIds`; `401`/`403`.

Modified existing: `GET /admin/users` adds `where deletedAt: null` (AC-5.3);
`GET /admin/users/{id}` returns `404` for a soft-deleted user (AC-5.4 — no admin-facing
browse).

### auth → notify-api internal email send

`POST /system/emails` (header `X-Internal-Token: <NOTIFY_INTERNAL_TOKEN>`; **not** a user JWT)
```jsonc
// request
{ "to":"alice@welld.ch","template":"invitation",
  "data":{ "inviteUrl":"https://auth…/invite?id=inv_1&token=…",
           "inviterName":"Admin","expiresAt":"2026-07-16T10:00:00Z" } }
// 200
{ "deliveryId":"del_1","status":"sent" }   // or {"status":"failed","error":"…"}
```
Errors: `401` (missing/wrong internal token), `400` (bad `to`/`template`), `502` upstream
Resend error surfaced as `{"status":"failed"}` (auth treats non-`sent` as a soft failure,
never fails the invitation).

## Test strategy

AC → level mapping is total (45 ACs). Levels: **U** unit, **I** integration (HTTP + DB /
hook + DB), **E** e2e (Playwright through admin-ui/shell). Hook and cross-service paths are
integration-tested against a real DB the way existing `*.routes.test.ts` do.

| AC | Level | What proves it |
|----|-------|----------------|
| 1.1 | I | `POST /admin/invitations` with and without roleIds/departmentIds → both create `pending`; stored ids on the row, nothing applied to any user |
| 1.2 | I | Create for an email with no active user + no pending invite → `pending` row, notify `/system/emails` called (mocked), row visible in list as `pending` |
| 1.3 | I | Create for an email owning an **active** user → `409`; assert no row, no email |
| 1.4 | I | Create for an email with a live-pending invite → `409` referencing the existing invite; partial-unique index also asserted at DB layer (U) |
| 1.5 | I | Create for an email whose only invites are expired/revoked → `pending` created; reconcile-on-write flip of the stale row asserted |
| 1.6 | I+E | List returns effective status per row + assigned roles/depts (I); admin-ui shows active-user vs pending vs neither for an email (E) |
| 1.7 | I | Created row has `invitedByUserId` + `createdAt`; `audit_log` row `invitation.create` written |
| 1.8 | I | Non-admin `POST /admin/invitations` → `403`; no row, no email |
| 1.9 | I | Revoke a pending/expired → `status='revoked'`; landing `GET /invite/state` returns `revoked`; hook match now excludes it |
| 1.10 | I | Resend a revoked → `422` |
| 1.11 | I | Revoke an accepted → `422` |
| 1.12 | I | Revoke writes `audit_log` `invitation.revoke` (actor+time) |
| 1.13 | I | Non-admin revoke → `403` |
| 1.14 | I | Create for a **soft-deleted** user's email → `pending` created (not blocked) |
| 2.1 | U+E | Template renderer emits IT+EN + single accept link (U); rendered email/landing copy check (E via mailbox stub) |
| 2.2 | E | Following the invite link (unauthenticated) lands on the hosted sign-in with Google/GitHub controls |
| 2.3 | I+E | `user.create.after` with matching verified email → invite `accepted`, user holds exactly invite roles/depts (+baseline), `perm_epoch` bumped; admin user-detail shows them applied (E) |
| 2.4 | I | `user.create.after` for a **different** verified email → invite stays `pending`, new user has only baseline; no invite grants applied |
| 2.5 | I+E | Landing state for expired/revoked/accepted/old-token → "no longer valid" with safe reason (I); subsequent OAuth is an ordinary sign-in, no activation (I hook test) |
| 2.6 | I+E | After acceptance the email is absent from `GET /admin/invitations?status=pending` and present in `GET /admin/users` (I); admin-ui reflects the move (E) |
| 3.1 | I | Resend a pending/expired → same row id/roleIds/deptIds preserved, new token + `expiresAt≈now+72h` |
| 3.2 | I | Resend → notify `/system/emails` called with the new link; effective status `pending` |
| 3.3 | U+I | Old token's sha256 no longer matches `tokenHash` (U); landing with old token → "no longer valid" (I) |
| 3.4 | I | Resend an accepted/revoked → `422` |
| 3.5 | I | Resend writes `audit_log` `invitation.resend` (actor+time) |
| 3.6 | I | Non-admin resend → `403` |
| 4.1 | U+I | Create/resend sets `expiresAt = now()+72h` from the latest action (U on the helper; I on the row) |
| 4.2 | I | A pending row past `expiresAt` renders effective `expired` in list/detail |
| 4.3 | I | Hook match query excludes `expiresAt<=now`; following an expired link + OAuth → no activation |
| 4.4 | I | An expired invite accepts resend and revoke; no action required (leaving it is valid) |
| 5.1 | I | `DELETE /admin/users/{id}` sets `deletedAt`, `session.deleteMany` removes all sessions in the same tx; a subsequent `getSession` for that user is empty |
| 5.2 | I | `session.create.before` for a soft-deleted user with no live-pending invite → session denied; no resurrection, no new user row |
| 5.3 | I+E | Deleted user absent from `GET /admin/users` and `?q=` search (I); absent from admin-ui list (E) |
| 5.4 | I | Post-delete: user row + account rows + estimates/notifications (fixtures) still present; `GET /admin/users/{id}` → `404` |
| 5.5 | I+U | Deleting the sole effective admin → `422`; `lastAdminGuard` counts only `deletedAt: null` admins (U) |
| 5.6 | I | Admin deleting own id → `422`, not deleted (single + bulk) |
| 5.7 | E | admin-ui requires a distinct confirm step before delete fires |
| 5.8 | I | Delete writes `audit_log` `user.delete` (actor+target+time); target row still referenced |
| 5.9 | I | Non-admin `DELETE`/bulk → `403` |
| 5.10 | I | Soft-deleted email re-invited then accepted → `deletedAt` cleared, roles = new invite's set (not prior), fresh activation, audit |
| 6.1 | I+E | Bulk delete of eligible users soft-deletes each (per-user AC-5.1..5.4 assertions) |
| 6.2 | I | Bulk incl. self + last-admin → those skipped, others deleted; self ALWAYS excluded |
| 6.3 | I+E | Bulk response lists `deleted` + `skipped[{reason}]` (I); admin-ui renders the report (E) |
| 6.4 | I | Bulk writes one `audit_log` per deleted user, none for skipped |
| 6.5 | I | Non-admin bulk → `403` |

Cross-cutting non-AC checks also required: internal-token middleware rejects a user JWT and
`/system/emails` rejects a missing/wrong token (security); Resend failure path records
`EmailDelivery.failed` + `Invitation.lastEmailStatus='failed'` and still returns `201`.

## Risks

- **R1 — `session.create.before` abort contract (better-auth 1.6.2).** The whole
  soft-delete gate (AC-5.2) depends on the before-hook being able to *deny* session
  creation. *Mitigation / early check:* spike the exact return value (`false` vs throw vs
  `{}`) against the pinned version in a focused integration test before building the
  feature; if unsupported, fall back to `session.create.after` + immediate `session.delete`
  + a denied-redirect (documented seam).
- **R2 — service-to-service auth / email-to-arbitrary-address abuse.** A leaked
  `NOTIFY_INTERNAL_TOKEN` lets an attacker send from wellD's Resend domain. *Mitigation:*
  internal-network-only exposure, strong 1Password-sourced token, never logged, fixed
  templates (only `to`/`inviteUrl`/`inviterName`/`expiresAt` are variable, all escaped), and
  an OWASP pass on `/system/emails`.
- **R3 — invite-token guessability / leak.** *Mitigation:* ≥32-byte CSPRNG token, stored as
  sha256 (`tokenHash`), rotated on resend; and critically the token grants **no access**
  (activation is verified-email match), so a leaked link at worst reveals invite state +
  one email address. Covered by AC-2.4/3.3 tests.
- **R4 — soft-delete JWT residual window.** Documented and accepted (see Architecture);
  *early check:* confirm `apiFetch`'s 401→refresh→redirect actually locks a deleted user out
  on first 401 in an e2e; escalate the optional resource-server liveness check only if the
  regulated-data posture requires it (ADR candidate).
- **R5 — Resend deliverability / failure.** *Mitigation:* verified sending domain + SPF/DKIM
  on `operai.welld.io`; synchronous send with failure surfaced to the admin; resend is the
  retry path; `EmailDelivery` log gives an audit of attempts.
- **R6 — admin-ui bulk-select UX / accidental mass delete.** *Mitigation:* distinct confirm
  step (AC-5.7) with the count and the partial-success report; the caller's own row omits
  the checkbox/delete; reuse existing `ConfirmDeleteModal`/`GuardrailDialog`.
- **R7 — migration on the live `user` table.** *Mitigation:* `deletedAt` is nullable with no
  default (no rewrite/backfill, existing rows read active); `lastAdminGuard`'s `deletedAt`
  filter ships in the *same* change so a deploy can't transiently mis-count admins.
- **R8 — no anti-abuse on invite create/resend (spec Non-goal, but operative).** A
  compromised admin could spam invitations. *Mitigation:* out of scope for behaviour, but
  the `EmailDelivery` + `audit_log` trails make abuse detectable; note for a later
  rate-limit ADR.
- **R9 — baseline-role vs "exactly the invite roles" ambiguity (AC-2.3).** Read as: the
  `employee` baseline is always assigned (AC-1.1 frames an empty invite as "the seed-role
  default") and invite roles are additive. *Mitigation:* decided here, surfaced for QE
  confirmation; not a spec amendment (resolvable within the mechanism). If QE reads AC-2.3
  strictly ("no more, no fewer" ⇒ strip `employee` when the invite names roles), the hook
  flips to replace-not-add — a one-line change, flagged so it's a conscious call.

## Security

**YES — security-sensitive.** This feature touches authentication and account lifecycle
(invitation, activation, soft-delete, re-sign-in gating), PII (email addresses), an external
outbound call (Resend), a new cross-service trust boundary (auth → notify-api service
token), and capability tokens (invite links). Per the plan gate this schedules an
**owasp-reviewer** pass in parallel with QE, **escalated to the frontier tier** (the suite
holds financial/personnel-adjacent regulated data — CLAUDE.md data-residency).

Surfaces to review specifically:
- `POST/GET /admin/invitations`, `.../{id}/resend`, `.../{id}/revoke` — admin gate,
  input validation, IDOR on invitation id, 409/422 information disclosure.
- `GET /invite` + `GET /invite/state` — public, unauthenticated: token handling
  (guessability, timing), email disclosure, HTML/JSX injection of `email`/`inviterName`,
  no-enumeration.
- `POST /system/emails` (notify-api) — service-token middleware (no user-JWT acceptance,
  no service-token acceptance on user routes), email-to-arbitrary-address abuse, template
  injection, log hygiene (no token/body logging).
- `user.create.after` + `session.create.before` hooks — verified-email trust, AC-2.4
  cross-identity isolation, AC-5.2 soft-delete gate, re-activation privilege reset.
- `DELETE /admin/users/{id}` + `POST /admin/users/delete` — self-delete/last-admin guards,
  session revocation completeness, bulk partial-success (no silent success), the residual
  JWT window (R4).

## ADR candidates

1. **notify-api email as a second delivery channel + auth→notify-api service-to-service
   trust model.** The channel abstraction (in-app→`sub`, email→address), Resend as MTA, and
   the shared-service-token internal endpoint (vs the rejected forwarded-user-JWT and the
   considered self-issued-audience-JWT) — a decision that constrains every future
   system/transactional send in the suite.
2. **Invitation activation seam + soft-delete account lifecycle.** The two-hook design
   (`user.create.after` verified-email matching; `session.create.before` soft-delete
   gate/re-activation), the retain-user+account / revoke-sessions cascade, and the
   **accepted residual-JWT window** (with the named-but-not-built resource-server liveness
   hardening) — constrains how account deletion and re-provisioning work suite-wide.
3. **Invitation lifecycle & expiry as derived state.** `status ∈ {pending,accepted,revoked}`
   with `expired` computed, reconcile-on-write, and the `pending` partial-unique index —
   the schedulerless expiry model future invitation-like features (e.g. Refund approvals)
   may reuse. (May be folded into #2 at the writer's discretion.)

## Spec amendment proposed

None. AC-2.3's baseline-vs-exact-roles wording (R9) is resolved within the plan as a
mechanism choice and surfaced for QE; it does not require changing the spec.
