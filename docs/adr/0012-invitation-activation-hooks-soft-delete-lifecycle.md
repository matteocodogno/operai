# 0012 — Invitation activation via two better-auth hooks, and a soft-delete account lifecycle with an accepted residual-JWT window

**Date:** 2026-07-14  
**Status:** Accepted  
**Deciders:** wellD  
**Project:** Operai

---

## Context

Spec `specs/006-user-invitations` requires two account-lifecycle transitions that better-auth's
default OAuth flow has no built-in concept of. First (US-2), an invited person's *first* OAuth
sign-in must be matched against a pending invitation for their **OAuth-verified** email and
automatically activated with exactly that invitation's roles/departments (AC-2.3) — while a
different verified identity clicking the same link must be unaffected (AC-2.4, the invite link
itself grants nothing). Second (US-5/US-6), an admin must be able to delete a user such that
their access is revoked immediately and synchronously (AC-5.1), a subsequent sign-in attempt
with the same verified email is refused rather than silently resurrected or treated as a new
sign-up (AC-5.2), and their data footprint elsewhere in the suite is retained untouched
(AC-5.4) — deletion is a locked spec Constraint as **soft**, not physical, delete.

better-auth fires `databaseHooks.user.create.after` exactly once, the moment a `user` row is
first persisted — the codebase's existing baseline-role assignment already depends on this
(specs/004). It does **not** fire again for a returning identity; better-auth matches the OAuth
`account` row first and only creates a session. This means invitation-matching and the
soft-delete gate cannot share one hook — a soft-deleted user's account row already exists, so
`user.create` never re-fires for them, and a *second*, distinct seam is required to intercept
their return. Both transitions must also interact correctly with `perm_epoch` (ADR-0007's live
permission-revalidation claim) and with the fact that resource servers verify a stateless,
7-day RS256 JWT with no revocation list (ADR-0005, further scoped by ADR-0010's `aud`
enforcement) — a soft-deleted user's already-issued token cannot be centrally invalidated the
way their better-auth session can.

## Decision

We will implement activation and the soft-delete gate as **two separate better-auth database
hooks**, and treat account deletion as a **soft delete with a synchronous cascade** that revokes
sessions but does not attempt to invalidate already-issued JWTs.

1. **`user.create.after` — new-user activation.** After the existing baseline-role assignment,
   look up a **live pending** invitation for the new user's own email —
   `status = 'pending' AND expiresAt > now() AND lower(email) = lower(user.email)` — gated on
   `user.emailVerified === true` (the same posture already used for bootstrap-admin matching:
   the email comes only from the OAuth provider's verified profile, never a request body). On a
   match, in one transaction: apply the invitation's `roleIds`/`departmentIds` (additive to the
   baseline `employee` role), set `status='accepted'` + `acceptedByUserId`, bump
   `permissionEpoch` (ADR-0007), and write an `audit_log` row. AC-2.4's cross-identity isolation
   falls out structurally: the match keys on the *new user's own verified email*, never on the
   invite-link token, which is UX/landing-only and never an authorization input.
2. **`session.create.before` — soft-delete gate + re-activation.** Fires on *every* session
   creation, including a returning identity whose `account` row already exists — the seam
   `user.create.after` cannot reach. Loads `{ deletedAt, email, emailVerified }` for the
   session's user: if `deletedAt == null`, allow normally (no invitation logic runs for an
   active user — AC-1.3 already guarantees an active user's email can't have a pending invite).
   If `deletedAt != null`, look for a live pending invitation for the verified email: found →
   re-activate (clear `deletedAt`, **replace** roles/departments with exactly the new
   invitation's set — not a resurrection of prior grants, per AC-5.10 — bump `permissionEpoch`,
   mark the invitation accepted, audit, then allow the session); not found → deny the session
   outright (AC-5.2) — no new user row is created, because the account row still maps to the
   existing soft-deleted user, so it is neither a resurrection nor an ordinary new sign-up.
3. **Delete is a soft delete with a synchronous cascade, scoped to `auth` only.** On
   `DELETE /admin/users/{id}` (and per-user inside the bulk variant), in one transaction:
   set `User.deletedAt` + `deletedByUserId`, `session.deleteMany({ userId })` (synchronous
   revocation, AC-5.1), bump `perm_epoch`, write an `audit_log` row. The `user` row, its
   `account` rows (so a future re-OAuth maps back to the *same* row and hits the gate above
   instead of spawning a fresh user), and its `user_role`/`user_department` rows are all
   retained (inert while `deletedAt` is set). **Resource servers (`estimai-api`, `notify-api`)
   do nothing at delete time** — no delete-time call, no schema change; their data referencing
   the deleted user is retained untouched (AC-5.4), because access is cut at the source: no
   session means the SPA cannot mint or refresh a JWT, and the gate above blocks re-sign-in.
4. **The residual-JWT window is accepted, not engineered away.** Resource servers verify a
   7-day RS256 JWT statelessly (ADR-0005) and have no way to know a user was just deleted until
   that token expires — a soft-deleted user's already-issued, in-memory (ADR-0001) JWT remains
   structurally valid at `estimai-api`/`notify-api` until it expires or the SPA hits a 401 and
   `apiFetch`'s refresh (which fails against the now-sessionless account) redirects to a sign-in
   that the gate above blocks. This window is deliberately **not** closed in v1: doing so would
   require every resource server to perform a live liveness/epoch check against `auth` on every
   request, which defeats the stateless-JWT design ADR-0005 chose, for a threat (a just-deleted
   insider racing their own token's expiry) judged low today. A lightweight `sub`/epoch liveness
   check at resource servers — or shortening JWT TTL — is named as the escalation path, not
   built here, if the regulated-data posture the suite is heading toward ever demands it.

## Options considered

### Option A — Two hooks (`user.create.after` + `session.create.before`); soft delete with synchronous session revocation; accepted residual-JWT window (chosen)

Described above.

**Pros:**
- Matches better-auth's actual firing semantics exactly: `user.create.after` fires once, for
  new rows only; `session.create.before` fires on every sign-in including returning ones — no
  seam is asked to do something it structurally cannot (catch a returning identity's first
  hook, or catch a genuinely new user's session-before)
- Keeps the `account`/`user` rows intact on soft-delete, so a soft-deleted person's later
  re-OAuth maps back to the *same* row and is correctly gated, rather than accidentally
  spawning a brand-new `employee` user via `user.create.after` (which would silently bypass the
  entire soft-delete/re-invite model)
- Reuses `perm_epoch` (ADR-0007) as the single mechanism that already exists for making
  permission changes take effect immediately at the next `GET /authz/me` revalidation — both
  activation and deletion push through the same lever rather than inventing a second one
- Being explicit that the residual-JWT window is accepted (not solved) keeps ADR-0005's
  stateless-verifier design intact for every resource server, avoiding a suite-wide coupling to
  `auth` on every single API call for a narrow, low-likelihood threat window

**Cons:**
- Two independent hook seams to keep correct and tested (better-auth's exact abort contract for
  `session.create.before` — `false` vs. a thrown error vs. an empty object — is unconfirmed
  against the pinned 1.6.2 version at plan time; see Risks)
- A soft-deleted user's valid-but-stale JWT can still authenticate to resource servers for up to
  the remainder of its 7-day lifetime — a real, if bounded and low-likelihood, access window
  that a stricter design would close
- Re-activation on the gate (found-pending-invite path) **replaces** roles/departments rather
  than restoring prior state, which is the correct product behaviour (AC-5.10) but means the
  gate must be careful not to conflate "reactivate" with "resurrect" — a subtle distinction that
  must be tested explicitly (AC-5.10)

### Option B — Single unified hook / poll-based reconciliation (rejected)

Attempt to handle both new-user activation and soft-delete gating from one seam — e.g. always
running invitation-matching logic inside a single `session.create.before` hook (dropping
`user.create.after` entirely), or reconciling soft-delete/invitation state lazily on the first
authenticated API call after sign-in rather than at the auth boundary.

**Pros:**
- One seam to reason about and test instead of two
- Avoids depending on the exact ordering/interaction between two separate better-auth hook types

**Cons:**
- `session.create.before` fires *after* better-auth has already resolved account matching; for
  a genuinely brand-new OAuth identity, `user.create.after` is the only seam that fires exactly
  once at the moment the row is created — folding activation into `session.create.before`
  would run the match on every subsequent sign-in too, not just the first, adding unnecessary
  invitation-matching cost and complexity to steady-state sign-ins for already-active users
- Reconciling at the first API call (rather than at auth) would mean a freshly-activated or
  freshly-blocked user briefly holds a session (and a JWT) that doesn't yet reflect their true
  state — reopening exactly the kind of narrow race the two-hook design avoids by deciding at
  session-creation time
- Rejected: better-auth's own hook semantics make the two-seam design the natural fit, not an
  arbitrary extra layer

### Option C — Resource-server-side live liveness/epoch check on every request (rejected for v1, escalation path)

Have `estimai-api`/`notify-api` call back to `auth` (or check a shared cache/table) on every
request to confirm the calling `sub` is still active and its `perm_epoch` current, closing the
residual-JWT window entirely.

**Pros:**
- Closes the residual-JWT window completely: a soft-deleted user's JWT would stop working the
  instant `deletedAt` is set, regardless of the token's remaining lifetime
- Extends the same "live, not embedded" philosophy ADR-0007 already applies to permissions
  (`GET /authz/me` revalidation) to account-liveness itself

**Cons:**
- Defeats the stateless-JWT resource-server design ADR-0005 deliberately chose — every request
  to every resource server would need a synchronous dependency on `auth` (or a shared
  cache/store kept in lock-step with it), reintroducing exactly the coupling ADR-0005 avoided
  by making JWKS verification self-contained
- Not justified by the threat model today: the window is bounded by JWT TTL, narrowed further
  in practice by `apiFetch`'s 401→refresh→redirect behaviour (ADR-0001), and applies only to a
  user who was *just* deleted and happens to be actively mid-session at that exact moment
- Rejected for v1, not on correctness grounds but on proportionality: this is recorded as the
  named escalation path (a lightweight `sub`/epoch liveness check, or a shorter JWT TTL) to
  adopt if the suite's regulated-data posture (financial/personnel-adjacent data, per
  CLAUDE.md) ever requires closing this window; it is not built here

## Consequences

**Positive:**
- Activation and soft-delete/re-activation are both driven off a single source of truth
  (verified OAuth email matched against a live-pending invitation) using the exact seam
  better-auth exposes for each case — no polling, no separate reconciliation job
- `perm_epoch` (ADR-0007) is reused as the one mechanism that makes both a grant (activation)
  and a revocation (deletion) take effect at the next permission revalidation, keeping the
  suite's authorization model to a single lever rather than two
- Account rows are never physically destroyed on deletion, preserving referential integrity for
  audit trails and any cross-service data still referencing the user (AC-5.4) — deletion is
  reversible in effect (via a fresh invitation, AC-5.10) without being reversible as an admin
  "undo" button (a non-goal the spec explicitly excludes)
- The residual-JWT window is documented, bounded, and consciously accepted rather than silently
  present — a future contributor or security reviewer reads this ADR instead of rediscovering
  the gap

**Negative / trade-offs:**
- Two hook seams (rather than one) must both be correctly implemented, ordered, and tested —
  more surface than a single seam, even though each individually is simple
- A soft-deleted user's previously-issued JWT keeps working at resource servers until it expires
  or the SPA's refresh cycle catches it — a real, accepted gap in immediate revocation, distinct
  from (and weaker than) the synchronous session revocation this ADR does provide
- Re-activation via a fresh invitation **replaces**, rather than restores, a soft-deleted user's
  prior roles/departments — correct per spec (AC-5.10) but a behaviour that must be explicitly
  understood by admins (a re-invited person does not automatically get back what they had before
  deletion)

**Risks:**
- **`session.create.before` abort contract (plan Risk R1).** The entire soft-delete gate
  depends on better-auth 1.6.2 supporting a genuine deny from this hook. Mitigation: spike the
  exact return contract (`false` vs. throw vs. `{}`) in a focused integration test before
  building the feature; if unsupported, fall back to `session.create.after` + immediate
  `session.delete` + a denied-redirect, a documented alternate seam.
- **Accepted residual-JWT window (plan Risk R4).** Already discussed above as a deliberate
  trade-off; the early check is confirming `apiFetch`'s 401→refresh→redirect actually locks a
  deleted user out promptly in practice (an e2e assertion), not closing the window mechanically.
- **Migration on the live `user` table (plan Risk R7).** `deletedAt` ships nullable with no
  default (no rewrite/backfill; existing rows read as active); the `lastAdminGuard`'s
  `deletedAt: null` filter must ship in the *same* change, or a deploy could transiently
  mis-count active admins.
- **Re-activation privilege-reset correctness.** A bug that merges new-invitation roles with
  the soft-deleted user's *prior* roles, instead of replacing them outright, would silently
  violate AC-5.10 (grant more access than the new invitation specifies). Mitigation: explicit
  integration test asserting the post-reactivation role set equals exactly the new invitation's
  set, not a union with the old one.

## Compliance notes

- GDPR/nLPD impact: medium — this decision governs how personal-data access is granted and
  revoked; soft-delete retains PII (email, name, prior role/department associations) rather than
  erasing it, which is the deliberate, spec-locked trade-off favouring audit/referential
  integrity over data minimisation for this internal wellD tool; a genuine erasure request would
  need a separate, not-yet-built hard-delete path (out of scope here)
- Data residency: unaffected — all invitation/session/user data remains in the existing EU
  Postgres instance (`auth`'s database), no new cross-border transfer is introduced
- Audit trail: required and provided — activation, re-activation, and deletion each write an
  `audit_log` row (ADR-0007's mechanism) recording actor, action, and target, satisfying AC-1.7/
  AC-3.5/AC-5.8/AC-6.4

This decision builds on ADR-0005 (JWT resource-server verification via remote JWKS — the
residual-JWT window is a direct, explicitly accepted consequence of that ADR's stateless
verification choice), ADR-0007 (authorization model — `perm_epoch` is the exact mechanism this
decision reuses for both activation and deletion to take effect at the next live permission
revalidation), and ADR-0010 (JWT `aud` enforcement — the JWT this decision cannot immediately
invalidate is the same audience-scoped token that ADR-0010 hardened against cross-service
replay; that hardening is orthogonal to, and does not close, the residual-window trade-off
recorded here).

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
