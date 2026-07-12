# 0007 — Authorization model: hand-rolled RBAC/ABAC in the auth service; identity+epoch JWT claims with live, epoch-invalidated permission resolution

**Date:** 2026-07-13  
**Status:** Accepted  
**Deciders:** wellD  
**Project:** Operai

---

## Context

The Operai suite authenticates users (ADR-0001/0002/0005) but has no notion of what a
signed-in user is allowed to do: every user can reach every app and every action in it.
Spec `specs/004-auth-roles-permissions` requires fine-grained authorization as the suite
starts handling financial and personnel data (refund approvals, HR): roles, departments,
per-resource/per-action permission rules with conditions (ownership + attribute),
admin-created custom roles at runtime, a per-app permission catalog, a management GUI, an
immutable audit trail, and — critically — **immediate** revocation (AC-4.3).

Today the `auth` service (better-auth 1.6.2 + Prisma/Postgres) does identity/session only.
It issues an RS256 JWT (verified by resource servers via remote JWKS, ADR-0005) carrying
only identity claims, with a 7-day lifetime and no revocation mechanism at the resource
server (ADR-0005's accepted trade-off). Any authorization model must fit inside that
existing token/verification design without reopening it, while making revocation feel
immediate to the user.

## Decision

We will hand-roll the authorization domain **inside the `auth` service**, keep the JWT
claims minimal (identity + a `perm_epoch` integer), and resolve fine-grained permissions
**live** via a new endpoint — rather than embedding permissions in the token or adopting
better-auth's `access`/`admin`/`organization` plugins.

1. **New authorization tables live in `auth/prisma/schema.prisma`**: `role`,
   `department`, `permission_rule` (with a `conditions` JSON column for ownership +
   attribute constraints), `user_role`, `department_role`, `user_department`,
   `catalog_resource`/`catalog_action`, and an append-only `audit_log`; plus
   `user.permissionEpoch`/`entity`/`jobTitle`. better-auth is reused **only** for
   identity/session and its one legitimate claim seam, `jwt.definePayload`.

2. **The better-auth `access`/`admin`/`organization` plugins are rejected**, though all
   three are present in `node_modules` and none is enabled. They model *statically
   code-defined* roles/statements and cannot express runtime-editable custom roles,
   ABAC conditions, a DB-backed catalog, or an audit trail. `organization` is additionally
   over-fitted to multi-tenant orgs (invitations, teams, tenancy) when the spec calls for
   a single wellD organization with simple departments.

3. **JWT claims stay minimal: identity + `perm_epoch`.** Roles and permissions are
   **not** embedded in the token. `auth/src/auth/auth.config.ts`'s `jwt.fields` is a
   dead no-op on better-auth 1.6.2 — the plugin spreads the entire `user` row into the
   token regardless (`node_modules/better-auth/dist/plugins/jwt/sign.mjs`). The only
   correct hook is `jwt.definePayload`, which we replace it with, returning exactly
   `{ email, name, image, perm_epoch }` (`sub` is unchanged — the plugin default,
   per ADR-0005). A 7-day token carrying a fat permission set would serve stale
   authorization for up to a week, defeating AC-4.3 outright.

4. **Fine-grained permissions are resolved live** via a new `GET /authz/me` endpoint
   (session-authenticated). The shell caches the response in memory (per ADR-0001's
   in-memory-only discipline) and revalidates on navigation, so a revoked grant is gone
   on the user's very next navigation or refresh — no waiting for the JWT to expire.
   `permissionEpoch` is bumped, in the same transaction as any authorization mutation, for
   every user the change affects (direct assignment → that user; role/department rule
   change → every user who inherits it). `perm_epoch` in the token is a **forward-looking**
   staleness marker: it is not consumed by anything yet, but it lets a **future** resource
   server cheaply detect "this token's view of permissions may be behind current state"
   and force a live re-resolution, without needing this feature's live-fetch mechanism
   itself to reach into every backend.

5. **The admin API lives inside the `auth` service** (`src/admin/`), authenticated by
   the existing session middleware plus a new `requireAdmin` role check — not as a
   separate resource server. This is a deliberate scope boundary: it means this feature
   does **not** create a second consumer of JWKS-verified bearer tokens, so ADR-0005's
   deferred `aud`-claim hardening is **not** triggered here. That hardening remains
   gated on the first real second resource server (`refund-api`).

6. **Per-app, per-record enforcement is explicitly out of scope for this decision.** This
   ADR covers the model, the claim/resolution mechanism, the admin GUI, the audit trail,
   and shell-level app-access gating (US-7 — hide/block apps a user cannot `access`).
   Each consuming app (EstimAI now, Refund and others later) enforces view/edit/delete/
   approve against these claims in its own spec, using its own declared catalog entries.

7. **The permission catalog is DB-backed and app-registered**, not a static registry
   inside `auth`. Each app ships a typed catalog declaration (resources, actions,
   supported condition types) and registers it idempotently via `PUT /authz/catalog`
   (a seed drives this for EstimAI/Admin/Refund at v1). A static in-`auth` registry was
   rejected: it would couple every app's catalog into the `auth` build and defeat
   independent app deployability (the same value ADR-0006 already protects for the
   frontend).

## Options considered

### Option A — Hand-rolled authz tables + minimal-claim JWT + live `/authz/me` (chosen)

Extend `auth`'s Prisma schema with the authorization domain; keep the token to identity
+ `perm_epoch`; resolve permissions live on demand, cached and invalidated by epoch.

**Pros:**
- Fully expresses runtime-editable custom roles, ABAC conditions (ownership +
  attribute), a queryable catalog, and an immutable audit trail — none of which the
  static better-auth plugins support
- Revocation is immediate (AC-4.3) without inflating the token or shortening its
  lifetime; the existing 7-day session/JWT design (ADR-0005) is untouched
- No new resource server, no new `aud` requirement — extends the existing identity
  authority rather than creating a second authenticated backend
- `perm_epoch` gives future resource servers a cheap staleness signal without forcing
  this feature to solve backend enforcement it doesn't yet need

**Cons:**
- A hand-rolled resolver (union of direct + department-derived roles, de-duplicated,
  widest-condition-wins) must be built, tested, and perf-tested in-house rather than
  inheriting a maintained plugin's logic
- The shell's app-access guard is UX-only — real enforcement is the server-side authz
  data here plus each app's own future enforcement; a determined client could still call
  an app's API directly (mitigated by that app's own future enforcement, out of scope
  here)
- A live `/authz/me` fetch adds a new runtime dependency on `auth`'s availability for
  every permission check (mitigated by in-memory, epoch-keyed caching in the shell,
  matching the existing JWT-cache pattern)

### Option B — better-auth `access`/`admin`/`organization` plugins (rejected)

Enable the plugins already present in `node_modules` and model roles/permissions through
their statically code-defined statement/role system, using `organization` for the
department concept.

**Pros:**
- No new tables to design; wired through existing, maintained better-auth plugin code
- Less code to hand-roll and test

**Cons:**
- Roles/statements are defined in code at build time — admin-created custom roles at
  runtime (AC-2.4) cannot be expressed
- No support for ABAC-style conditions (ownership, entity/department/job-title
  attribute matching — AC-2.2/2.3)
- No catalog concept, no audit trail — both hard spec requirements (US-3, US-5)
- `organization` is designed for multi-tenant orgs (invitations, per-org membership,
  teams) — over-fitted for a single-org "department" concept and would import
  complexity and constraints (e.g. org-scoped session data) the spec explicitly doesn't
  need (non-goal: multi-tenant/multi-organization)
- Rejected: none of the three plugins fit the runtime-editable ABAC + catalog + audit
  model the spec requires

### Option C — Fat permission claims embedded in the JWT (rejected)

Resolve the user's effective permissions at token-mint time and embed the full set
(roles, resources, actions, conditions) directly in the JWT payload.

**Pros:**
- Zero extra network round-trip for permission checks — the token is self-contained
- No new `/authz/me` endpoint or live-resolution dependency

**Cons:**
- Directly defeats AC-4.3 (immediate revocation): the existing token lifetime is 7
  days (ADR-0005), so a revoked permission would remain valid in already-issued tokens
  for up to a week unless every consumer independently re-verified against a live source
  anyway — negating the point of embedding the claim
- Token size grows with the number of roles/rules a user holds, which is unbounded from
  the auth service's perspective and a poor fit for an HTTP header
- Rejected on the AC-4.3 staleness failure alone; the recommended direction in the spec
  (small token + epoch + live resolution) was chosen instead

### Option D — A separate standalone authorization microservice (rejected)

Stand up a new service (its own deploy, its own datastore or a shared one) dedicated to
roles/permissions, independent of `auth`.

**Pros:**
- Clean service boundary; authorization could evolve on its own release cadence
- Would not add tables/endpoints to the identity service's codebase

**Cons:**
- Creates a **second resource server** immediately, triggering ADR-0005's deferred `aud`
  hardening ahead of schedule and adding a new authenticated network hop to every
  permission check and to `auth` itself (which would need to call out to it for
  `definePayload`/`perm_epoch` bookkeeping)
- Authorization is fundamentally an extension of "who is this user and what do they
  hold" — splitting it from the identity authority duplicates user/session context across
  two services for no separation-of-concerns benefit at this suite's current scale
- Rejected: extends the existing authority in place; avoids a new deploy and a new
  resource server before one is otherwise needed

### Option E — Static in-`auth` permission catalog registry (rejected)

Hard-code each app's resources/actions/conditions as a registry inside the `auth`
service's own codebase, rather than having apps declare and register their catalog.

**Pros:**
- No new registration endpoint; one place to read the whole suite's catalog

**Cons:**
- Couples every app's catalog to the `auth` service's build and deploy — adding an
  EstimAI action or a new Refund resource would require a change and redeploy of `auth`
  itself
- Contradicts the suite's established pattern of independent per-app deployability
  (ADR-0006); apps should own and ship their own catalog declaration
- Rejected: `PUT /authz/catalog` (idempotent, app-declared) scales to independently
  deployed apps without an `auth` redeploy per catalog change

## Consequences

**Positive:**
- One authorization authority for the whole suite, colocated with the existing identity
  authority — no new service, no new deploy, no new `aud` requirement yet
- Admin-created custom roles, ABAC conditions, a queryable catalog, and an immutable
  audit trail are all fully supported — none were available from better-auth's plugins
- Revocation is genuinely immediate (next navigation/refresh) without inflating the JWT
  or shortening its lifetime
- The claim seam is fixed correctly as a side effect: `definePayload` replaces the dead
  `jwt.fields` no-op, closing the accidental whole-user-row leak into every token
- `perm_epoch` is a cheap, forward-compatible hook for future resource servers to detect
  stale authorization state without redesigning the token again

**Negative / trade-offs:**
- A hand-rolled resolver (union across direct + department roles, de-duplicated,
  widest-condition-wins) is now wellD's code to maintain, test, and performance-tune —
  there is no upstream plugin absorbing that complexity
- The shell's app-access guard (US-7) is UX-only; it prevents an app from being
  *mounted* for an unauthorized user but is not a substitute for server-side enforcement.
  Real enforcement is the `requireAdmin`/`GET /authz/me` server-side authority here, plus
  each app's own future per-record enforcement
- `GET /authz/me` introduces a new runtime dependency: every permission check now
  depends on `auth`'s availability, mitigated but not eliminated by in-memory,
  epoch-keyed caching in the shell (mirroring the ADR-0001 JWT cache)
- The backend immediacy mechanism (`perm_epoch` compared against a live-resolved
  current epoch) is designed now but not exercised by any resource server yet — it will
  only be proven correct when the first backend (`refund-api`) actually enforces
  permissions against it

**Risks:**
- **Resolution performance under load.** The union-across-roles-and-departments query
  runs on every `GET /authz/me` call (and on every shell navigation). Mitigation:
  indexes on the join columns, a bounded query shape, epoch-keyed caching in the shell,
  and a seeded worst-case perf test (many roles/rules) before production traffic.
- **Claim regression.** `definePayload` must continue to return every claim an existing
  consumer relies on (`estimai-api` reads `sub`+`email`) while adding `perm_epoch`.
  Mitigation: a contract test asserting the minted token still yields `sub`+`email`,
  run against `estimai-api`'s verifier before merge.
- **JWKS key-source split (inherited from ADR-0005).** Tokens carrying the new claims
  are signed by the DB-backed `jwks` keypair and verified via `AUTH_JWKS_URL=/auth/jwks`;
  the orphaned `/.well-known/jwks.json` (env keypair) remains unrelated and unused — no
  new impact from this decision, but it stays a live footgun until removed.
- **Privilege escalation via custom roles.** A custom role/rule must never be able to
  grant `admin`-equivalent authority to a non-admin, and the catalog must be the sole
  source of grantable `(resource, action)` pairs. Mitigation: `requireAdmin` gates every
  admin mutation; the last-admin guard (AC-6.4) prevents a lockout; an owasp-reviewer
  pass is scheduled for this feature.
- **Scope creep pressure toward per-app enforcement.** Because the claims and live
  endpoint now exist, it will be tempting to have this feature also enforce inside
  EstimAI. Mitigation: this ADR and the spec explicitly scope enforcement out; each
  consuming app enforces in its own later spec.

## Compliance notes

- GDPR/nLPD impact: medium — new PII-adjacent attributes (`user.entity`, `user.jobTitle`)
  are introduced to drive attribute-based conditions, and the audit trail records actor,
  target, and diff for every authorization change. These are necessary for governing
  access to financial/personnel data (the stated driver for this feature) and are stored
  in the same EU-hosted `auth` Postgres database as existing user data — no new data
  residency exposure.
- Data residency: unchanged — all new tables live in the existing `auth` service's
  PostgreSQL database (Railway EU), same as identity/session data.
- Audit trail: **required and delivered** — every authorization mutation (role,
  department, rule, membership create/edit/delete/assign/revoke) writes an immutable
  `audit_log` row (actor, timestamp, target, summary, before/after) in the same
  transaction as the change and its epoch bump; no update/delete route exists for audit
  entries.

This decision builds directly on: ADR-0001 (in-memory caching discipline — the shell's
permission cache follows the same never-persist-to-web-storage rule as the JWT cache),
ADR-0002 (the `auth` service remains the suite's single identity authority; a
no-permissions state is a UI empty state, not a sign-in redirect), ADR-0005 (claims ride
the same RS256/JWKS-verified token; `sub` semantics are unchanged; the admin API's choice
to live inside `auth` rather than as a new resource server is what keeps this feature from
triggering ADR-0005's deferred `aud` hardening), and ADR-0006 (the Admin GUI ships as a
federated remote with no own guard/chrome, consuming `shell/session`; app-access
enforcement is the shell's job, not the remote's).

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
