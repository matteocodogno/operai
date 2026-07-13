---
spec: 004
status: approved
---

# Plan: Authorization — roles, departments & fine-grained permissions

## Summary of approach

Extend the existing **better-auth `auth` service** with a hand-rolled authorization
domain (roles, departments, per-resource/action rules with conditions, catalog, audit).
Reuse better-auth **only** for identity/session and its one claim seam
(`jwt.definePayload`). Surface a **small** token (identity + a permission *epoch*) and
resolve fine-grained permissions **live** from a new `GET /authz/me` endpoint, so
revocation is immediate. Add a **dedicated `admin-ui` federated remote** for the GUI, and
teach the **shell** to gate app access (nav + route guard). This is a **UI feature** and
**security-sensitive** (authorization, PII, financial-data governance).

---

## Architecture

### Where each piece lives

| Concern | Home | Why |
|---|---|---|
| Authz data model + resolution + admin API | **`auth` service** (new `src/authz/`, `src/admin/`) | `auth` is the identity authority; the Admin API verifies its own session (no new resource server → avoids ADR-0005's `aud` hardening trigger). Extends ADR-0005. |
| Permission claim (`perm_epoch`) in the JWT | `auth` `jwt.definePayload` | The only correct claim seam (see below); ADR-0005 constraint — claims ride the same RS256/JWKS-verified token. |
| Live effective-permissions endpoint | `auth` `GET /authz/me` | Immediate revocation needs a live source; a 7-day JWT can't carry fresh authorization (ADR-0005 no-revocation trade-off). |
| Management GUI | **new `admin-ui` remote** | ADR-0006 — a tool is a runtime remote with no own guard/chrome; consumes `shell/session`. Matches the spec's "dedicated Admin remote" constraint. |
| App-access enforcement (US-7) | **shell** (`router.tsx` guard + `tools.ts`/`Sidebar` filter) | ADR-0006 — remotes have no guard; the shell is the only choke point (`_authed` `beforeLoad`, `shell/src/router.tsx:74-84`). |
| Per-record action enforcement | **each consuming app, later** | Explicit spec non-goal; this feature only produces the model + claims they will read. |

### The JWT claim seam (critical finding)

`auth/src/auth/auth.config.ts:38-53` configures the better-auth `jwt` plugin, but its
`jwt.fields: ["sub","email","name","image"]` is a **no-op** — the installed better-auth
`1.6.2` ignores it and spreads the **entire `user` row** into the token
(`node_modules/better-auth/dist/plugins/jwt/sign.mjs:52-62`). The only correct
customization hook is **`jwt.definePayload`** (`plugins/jwt/types.d.mts:88-103`). We
replace the dead `fields` with a `definePayload` that returns a **minimal, deliberate**
payload:

```
definePayload(session) → {
  email, name, image,          // identity consumers already read (estimai-api reads email)
  perm_epoch: <user.permissionEpoch>   // NEW — forward-looking staleness marker
}
// sub is added by the plugin (getSubject default = user.id) — DO NOT change sub semantics (ADR-0005)
```

**We deliberately do NOT put roles or the permission set in the token.** A 7-day token
(`expirationTime: "7d"`) would carry stale authorization until refresh — fatal for
AC-4.3 (immediate revocation). Roles/permissions are resolved **live** instead. `perm_epoch`
is a small integer that lets future *backends* cheaply detect a stale token (compare to a
short-TTL-cached current epoch) and force a refresh; for this feature the enforcing
consumers (Admin GUI, shell) read live state, so immediacy holds without leaning on the
token.

**Why hand-roll instead of better-auth `access`/`admin`/`organization` plugins** (all
present in `node_modules`, none enabled): those model *statically code-defined* roles/
statements. The spec requires **admin-created custom roles at runtime**, **conditions**
(ownership + attribute), a **catalog**, an **audit trail**, and **departments** (not
multi-tenant orgs — the `organization` plugin is over-fitted: invitations/teams/tenancy we
don't want). The plugins don't fit the runtime-editable ABAC model, so we hand-roll the
authz tables + resolution and keep better-auth for identity only. *(This is the core
decision an ADR should capture — see "New ADR" below.)*

### Immediate revocation (AC-4.3) — the mechanism

- **Admin GUI**: talks to the `auth` DB directly → always live.
- **Shell (US-7)**: `shell/session` gains `ensurePermissions()` (fetch `GET /authz/me`,
  in-memory cache mirroring the JWT cache per ADR-0001). Tool-route `beforeLoad`
  revalidates on navigation → a revoked app disappears on the next navigation/refresh
  (AC-7.5). Navigations are user-paced, so revalidation is cheap.
- **Epoch bump**: any authz change bumps `user.permissionEpoch` for **every affected user**
  (direct assignment → that user; role/department change → all users who inherit it, one
  `UPDATE … WHERE`). This invalidates epoch-keyed caches (shell now, backends later).
- **Backends (later specs)**: verify the token (ADR-0005), read `perm_epoch`, and resolve
  permissions live (cached by epoch); a token whose epoch is behind the user's current
  epoch is treated as stale. Documented now; enforcement deferred.

### New `admin-ui` remote (ADR-0006 shape)

Mirrors `estimai-ui`/`refund-ui` exactly (per the federation exploration): exposes
`admin/App` (own inner TanStack router, basepath `/admin`, no guard/chrome), consumes
`shell/session` + `shell/tokens.css`, same shared singletons. Wiring the shell needs:
`ToolId` += `'admin'` and a `TOOLS` entry (`shell/src/lib/tools.ts:16,30`), a `TOOL_ICONS`
entry (`Sidebar.tsx:74`), an `admin/App` ambient decl (`shell/src/federation/remotes.d.ts`),
a `remotes` entry + `ADMIN_REMOTE_URL` (`shell/vite.config.ts:37,91`), a `/admin/$` route
(`router.tsx`), the Tailwind `@source` (ADR-0006 addendum), and the origin added to shell
CSP / auth `ALLOWED_ORIGINS` / the `apiFetch` trusted-origin allowlist.

### ADR

The authorization model + claim/revocation strategy is recorded in
**`docs/adr/0007-authz-hand-rolled-rbac-abac-epoch-claims.md`** (Accepted, 2026-07-13):
hand-roll vs better-auth plugins; per-resource/action + conditions; departments ≠ orgs;
DB-backed catalog + registration; small token (identity + `perm_epoch`) + live `/authz/me`;
admin API inside `auth` (no second resource server yet); builds on ADR-0001/0002/0005/0006.

---

## Data model

New tables in `auth/prisma/schema.prisma` (conventions from the schema exploration: cuid
PKs, `@@map` lowercase, `createdAt`/`updatedAt`, FK `onDelete: Cascade` to `user`). A
**new** migration via `bun run db:migrate` — never edit `20260415155105_init`.

**`user` — new columns** (additive, nullable/defaulted so the migration is safe on
existing rows):
- `permissionEpoch Int @default(0)` — bumped on any authz change affecting the user.
- `entity String?` — `welld_ch` | `welld_it` (attribute condition target; admin-set).
- `jobTitle String?` — attribute condition target (admin-set).

**New models:**
- `role` — `id`, `name @unique`, `description String?`, `isSystem Boolean @default(false)`
  (seed roles), timestamps. Custom roles = `isSystem:false`.
- `department` — `id`, `name @unique`, `description String?`, timestamps. (The "group".)
- `permission_rule` — `id`, `roleId → role (Cascade)`, `resource String`, `action String`,
  `conditions Json?` (shape below), timestamps. A role is a bundle of rules.
- `user_role` — `userId → user (Cascade)`, `roleId → role (Cascade)`, `assignedByUserId String?`,
  `assignedAt`. `@@id([userId, roleId])`.
- `department_role` — `departmentId → department (Cascade)`, `roleId → role (Cascade)`.
  `@@id([departmentId, roleId])`.
- `user_department` — `userId → user (Cascade)`, `departmentId → department (Cascade)`,
  `assignedByUserId String?`, `assignedAt`. `@@id([userId, departmentId])`.
- `catalog_resource` — `id`, `appId String` (e.g. `estimai`), `key String` (e.g. `estimate`,
  or the app itself for `access`), `label String`, `@@unique([appId, key])`, timestamps.
- `catalog_action` — `id`, `resourceId → catalog_resource (Cascade)`, `key String`
  (`view`/`create`/`edit`/`delete`/`approve`/`access`), `label String`,
  `supportedConditions String[]` (which condition types apply), `@@unique([resourceId, key])`.
- `audit_log` — `id`, `actorUserId String?` (FK `onDelete: SetNull` — keep the record if
  the actor is later deleted), `action String` (e.g. `role.create`, `user_role.revoke`),
  `targetType String`, `targetId String?`, `summary String`, `data Json?` (before/after),
  `createdAt`. **No update/delete routes** → immutable (AC-5.3).

**`conditions` JSON shape** (per rule):
```
{ "ownership": "own" | "any",              // AC-2.2
  "attributes": [ { "key": "entity"|"department"|"jobTitle", "match": "user" } ] }  // AC-2.3
```
`match:"user"` means "the record's attribute must equal the acting user's attribute" — the
rule stores the *intent*; the comparison happens in each app's later enforcement. This spec
persists and surfaces conditions; it does not evaluate them against records.

**Effective permissions (resolution)** = union over the user's roles (direct `user_role`
∪ department-derived `department_role` for the user's `user_department`) of their
`permission_rule`s, de-duplicated by `(resource, action)` (widest condition wins:
`ownership:any` ⊃ `own`; fewer attribute constraints ⊃ more) — AC-4.2, AC-4.4 (absent =
denied).

---

## API contracts

New auth-service modules following the `OpenAPIHono` sub-router pattern
(`auth/src/index.ts:32-35`), RFC 7807 errors (`index.ts:56-90`), guarded by
`sessionMiddleware` + `requireAuth` (`auth/src/auth/auth.middleware.ts`) + a **new
`requireAdmin`** middleware (reads `c.get("user")`, checks the user holds the `admin` role;
**403** Problem-JSON otherwise — a role gate, distinct from ADR-0005's per-record 404).

### Caller-facing

- `GET /authz/me` — (sessionMiddleware + requireAuth) the caller's live effective
  permissions.
  `200 → { epoch, apps: string[], roles: string[], departments: string[], permissions: [{ resource, action, conditions }] }`.
  `apps` = resources whose action `access` is granted (shell convenience for US-7).
  `401 →` Problem-JSON if no session.

### Admin (all: sessionMiddleware + requireAuth + requireAdmin; `403` for non-admin — AC-1.5)

| Method + path | Purpose | Notes / errors |
|---|---|---|
| `GET /admin/roles` · `POST /admin/roles` | list / create role | 201; `409` duplicate name |
| `GET/PATCH/DELETE /admin/roles/:id` | read / rename / delete | `DELETE` of `isSystem` role → `422` |
| `PUT /admin/roles/:id/rules` | set the role's rules (from catalog) | `422` if a `(resource,action)` not in catalog (AC-2.1/3.2); or a condition not in `supportedConditions` |
| `GET /admin/departments` · `POST` · `GET/PATCH/DELETE /:id` | manage departments; **`GET /:id` includes the member list** (design drift fix — AC-1.2 is department-centric) | `409` duplicate name |
| `PUT /admin/departments/:id/roles` | set roles a department confers | `422` unknown role |
| `PUT /admin/departments/:id/members` | set the department's members from the department side (symmetric with the user-side assignment; **design drift fix** for AC-1.2 "create a department and add users to it") | bumps affected epochs |
| `GET /admin/users` · `GET /admin/users/:id` | list users + their roles/departments/attributes; **`?q=` search** on name/email (design drift fix — the users screen needs it) | paginated |
| `PATCH /admin/users/:id` | set `entity` / `jobTitle` | validated enum for entity |
| `PUT /admin/users/:id/roles` · `PUT /admin/users/:id/departments` | (re)assign | bumps affected epoch; last-admin guard (AC-6.4) → `422` |
| `GET /admin/users/:id/permissions` | a user's resolved **effective permissions** (the resolver output for any user — lets an admin verify what an assignment produces; **design drift fix** — `/authz/me` is caller-scoped only) | admin-only; same shape as `/authz/me` minus identity |
| `GET /admin/catalog` | resources + actions + condition types for the rule-builder | AC-3.1/3.3 |
| `GET /admin/audit` | paginated authorization-change history | AC-5.2; read-only |

Every mutating admin route: (1) writes an `audit_log` row (actor, target, summary, diff —
AC-5.1) and (2) bumps `permissionEpoch` for affected users (AC-4.3), in one transaction —
via the shared `withAudit(mutate(tx))` helper (T7), so each route passes its domain write
through that callback rather than hand-rolling its own transaction.

**Wire-shape conventions** (fixed by the admin-ui client T16; backend T8–T10 MUST match):
- **Pagination** (`GET /admin/users`, `GET /admin/audit`): query `?page=&pageSize=`;
  response envelope `{ items, page, pageSize, total }`.
- **Collection-set PUTs** use a named-field wrapper object, never a bare array:
  `PUT …/roles/:id/rules` → `{ rules }`; `…/departments/:id/roles` → `{ roleIds }`;
  `…/departments/:id/members` → `{ userIds }`; `…/users/:id/roles` → `{ roleIds }`;
  `…/users/:id/departments` → `{ departmentIds }`.

### Catalog registration (AC-3.1/3.4)

- Each app ships a typed **catalog declaration** (a constant: `appId`, resources → actions
  → supported conditions). EstimAI's declaration (`estimate` → view/create/edit/delete +
  app `access`) is added to `estimai-ui`/`estimai-api` as part of this feature — declaration
  only, **no enforcement** (AC-3.4 / non-goal).
- `PUT /authz/catalog` — (requireAdmin **or** a service key) idempotent upsert of an app's
  catalog into `catalog_resource`/`catalog_action`. v1 registers EstimAI + Admin + Refund
  catalogs via a **seed** that reads the checked-in declarations; the endpoint exists so
  future independently-deployed apps can self-register. *(Rejected: a static in-`auth`
  registry — couples every app's catalog into the auth build; DB-backed + registration
  scales to decoupled apps.)*

### Bootstrap & seed (US-6)

- New validated env var `BOOTSTRAP_ADMIN_EMAIL` (`auth/src/lib/env.ts` Zod pattern;
  document in `.env.example`).
- **Seed** (idempotent, run at deploy): create system roles `employee`, `admin`,
  `accounting`, `hr` (AC-6.2) + their catalogs.
- **better-auth `databaseHooks.user.create.after`** (auth.config.ts): on every new user,
  assign `employee` (AC-6.3); if `email === BOOTSTRAP_ADMIN_EMAIL`, also assign `admin`
  (AC-6.1) — no manual DB edit.
- Last-admin guard: any op that would drop the final `admin` assignment → `422` (AC-6.4).

### Shell (US-7)

- `shell/src/lib/session.ts`: add `ensurePermissions()` / `usePermissions()` (fetch
  `/authz/me` via the already-trusted `VITE_AUTH_URL`, in-memory cache; cleared on sign-out
  alongside the JWT). No new storage (ADR-0001).
- `shell/src/router.tsx`: `_authed`/tool-route `beforeLoad` loads permissions; a tool route
  the user lacks `access` for → `redirect` to a permitted app or a `/no-access` state
  (AC-7.3); revalidated per navigation (AC-7.5).
- `shell/src/lib/tools.ts` + `Sidebar.tsx`: filter `TOOLS` by the user's `apps` (AC-7.1/7.2);
  a tool→resource-key map. `/no-access` empty state when `apps` is empty (AC-7.4).

---

## Test strategy (every AC mapped)

| AC | Level | What verifies it |
|---|---|---|
| AC-1.1 create/rename/delete role | integration (auth) | POST/PATCH/DELETE `/admin/roles` → DB + list reflects |
| AC-1.2 department + members inherit | integration | membership → `/authz/me` of a member includes dept roles |
| AC-1.3 assign role → effective perms | integration | assign → member's `/authz/me` gains the rules |
| AC-1.4 revoke → removed | integration | revoke → `/authz/me` no longer includes them |
| AC-1.5 non-admin denied | integration + e2e | non-admin → `403` on every `/admin/*`; admin-ui route blocked in shell |
| AC-2.1 only catalog perms | integration | `PUT rules` with off-catalog `(resource,action)` → `422` |
| AC-2.2 ownership condition | integration | rule persists `ownership` + surfaces in `/authz/me` |
| AC-2.3 attribute condition | integration | rule persists entity/department/jobTitle condition; off-`supportedConditions` → `422` |
| AC-2.4 custom role assignable | integration + e2e | create custom role, assign, member sees its rules |
| AC-3.1 catalog available | integration + component | `GET /admin/catalog` returns registered apps; rule-builder lists them |
| AC-3.2 unknown perm rejected | integration | (same as AC-2.1 negative) |
| AC-3.3 app-access determinable | integration | `/authz/me.apps` reflects `access` grants |
| AC-3.4 EstimAI declares catalog | integration/unit | EstimAI catalog registered; `GET /admin/catalog` includes `estimate` + `access` |
| AC-4.1 perms obtainable | integration | `/authz/me` shape = enumerable (resource, action, conditions) |
| AC-4.2 union direct+dept, no dup | unit (resolver) + integration | resolver de-dups, widest condition wins |
| AC-4.3 immediate | integration + e2e | change → next `/authz/me` reflects it with no token refresh; epoch bumped |
| AC-4.4 default-deny | unit + integration | absent (resource,action) ⇒ not in `/authz/me` |
| AC-5.1 change logged | integration | each mutation writes an `audit_log` row (actor/target/diff) |
| AC-5.2 audit viewable | integration + component | `GET /admin/audit` paginates; admin-ui renders it |
| AC-5.3 audit immutable | integration | no update/delete route; attempt → `404/405` |
| AC-6.1 bootstrap admin | integration | user with `BOOTSTRAP_ADMIN_EMAIL` gets admin on create |
| AC-6.2 seed roles | integration | seed → 4 system roles exist, editable |
| AC-6.3 baseline employee | integration | new user → holds `employee` |
| AC-6.4 last-admin guard | integration | removing last admin → `422` |
| AC-7.1 hide inaccessible | component + e2e | Sidebar omits apps without `access` |
| AC-7.2 show accessible | component + e2e | Sidebar lists granted apps |
| AC-7.3 deep-link blocked | e2e | navigating to an un-permitted tool route → `/no-access`/permitted app, not mounted |
| AC-7.4 no-apps empty state | component + e2e | zero `apps` → clear empty state |
| AC-7.5 revoke → gone next nav | e2e | revoke `access` → tool disappears + route blocked on next navigation |

Frameworks (existing): `auth`/`estimai-api` = `bun test` (integration against a test DB);
`shell`/`admin-ui` = Vitest (unit/component) + Playwright (e2e, seeded-session helper).
The resolver (effective-permissions union/dedup) gets focused unit tests.

---

## Risks

- **R1 — JWT staleness vs. immediate revocation.** A 7-day token can't carry fresh
  authorization. *Mitigation:* live `/authz/me` + per-navigation revalidation in the shell;
  `perm_epoch` for future backends. *Early check:* prototype the revalidate-on-nav path
  before building the full admin GUI.
- **R2 — `definePayload` drops a claim a consumer needs.** Today the token accidentally
  carries the whole user row; `estimai-api` reads `email`+`sub`. *Mitigation:* `definePayload`
  must return `email` (+`name`/`image`); `sub` stays via the plugin default (never change
  `sub` — ADR-0005). *Early check:* a contract test asserting the minted token still yields
  `sub`+`email`, run against `estimai-api`'s verifier before merge.
- **R3 — resolution performance.** Union across role/department rules per `/authz/me`.
  *Mitigation:* indexes on the join columns, resolve in a bounded query set, epoch-keyed
  shell cache; measure with a seeded worst-case (many roles/rules).
- **R4 — JWKS key-source split.** Tokens are signed by the DB `jwks` keypair (`kid`=cuid);
  the orphaned `GET /.well-known/jwks.json` publishes the *env* key (`kid:operai-auth-rs256-v1`).
  Our enriched claims ride the DB-signed token, which `estimai-api` already verifies via
  `AUTH_JWKS_URL=/auth/jwks` — so **no impact on our path**. *Mitigation:* note the orphaned
  endpoint for a later cleanup; don't point any verifier at it.
- **R5 — `aud` hardening (ADR-0005 deferred).** Triggered only by a *second resource server*.
  *Mitigation:* the admin API lives **inside `auth`** (verifies its own session, not JWKS) →
  not triggered now. Flag that `refund-api` (a real second resource server) must add `aud`.
- **R6 — catalog drift.** Apps' declarations vs. registered catalog. *Mitigation:* typed
  declarations + idempotent registration; seed re-registers on deploy.
- **R7 — shell is "no role-based filtering" by design today** (`Sidebar.tsx:12`, static
  `TOOLS`). *Mitigation:* additive permission-filter layer; keep the roving-tabindex/icon
  invariants (recent shell work) intact.
- **R8 — better-auth version drift.** `package.json` pins `^1.2.5` but `1.6.2` is locked.
  *Mitigation:* align `package.json` to `^1.6.2` and run the auth test suite; confirm
  `definePayload`/`databaseHooks` behave as on 1.6.2.

---

## Security

**YES — security-sensitive** (this feature *is* access control; handles PII —
user `entity`/`jobTitle`; governs financial/HR-data access). Schedule an
**owasp-reviewer pass in parallel with QE**. Focus areas:

- **A01 Broken Access Control** — the whole feature: `requireAdmin` on every `/admin/*`;
  default-deny resolution (AC-4.4); the shell guard is UX only (real enforcement is
  server-side authz here + per-app later); IDOR on admin `:id` routes.
- **Privilege escalation** — a custom role/rule must not be able to grant `admin`-equivalent
  authority to a non-admin, or let a non-admin edit authz; catalog restricts grantable perms.
- **A04 Insecure Design** — last-admin guard (AC-6.4); immediate revocation actually
  immediate; bootstrap-admin can't be spoofed via a self-set email (email comes from the
  verified OAuth identity, not user input).
- **A09 Logging** — audit completeness/immutability (AC-5.1/5.3); never log tokens/secrets
  (existing convention).
- **Token surface** — `definePayload` must not leak sensitive attributes into the JWT
  (keep it identity+epoch); `/authz/me` only ever returns the **caller's own** permissions.
- **CORS/CSP/allowlist** — new `admin-ui` origin added to shell CSP, auth `ALLOWED_ORIGINS`,
  `apiFetch` trusted origins (ADR-0006).

---

## Open question carried from the spec

The exact backend immediacy mechanism (how a future resource server reconciles a 7-day
token's `perm_epoch` with live state) is **designed but not exercised here** (backends are
out of scope). This plan commits to: small token + `perm_epoch` + live `/authz/me`, shell
revalidation on navigation. Backend enforcement lands in each app's own spec (`refund-api`
first), which will also add `aud` (ADR-0005 R5).

---

## Post-implementation reconciliations (2026-07-13)

Minor plan-vs-reality notes surfaced by QE + eval and reconciled at close (no behavior change):

- **EstimAI catalog location.** The "Catalog registration" section says EstimAI's catalog
  declaration is "added to `estimai-ui`/`estimai-api`." `estimai-api` doesn't exist yet
  (planned, dir empty), so T26 placed the typed declaration at
  `auth/src/authz/catalogs/estimai.ts` and registers it via the deploy-time seed. AC-3.4's
  observable behaviour (`GET /admin/catalog` includes EstimAI's `estimate` resource + `access`)
  is unchanged and tested. When `estimai-api` is built, the declaration can move there.
- **US-7 test level.** The test-strategy table names **e2e** for the shell route-boundary ACs
  (AC-7.3 deep-link block, AC-7.5 revoke-on-next-nav, the admin-ui leg of AC-1.5). Delivered
  at **vitest/jsdom component/integration** level (`shell/src/router.access-guard.test.tsx`,
  `Sidebar.test.tsx`) against a mocked `/authz/me` — thorough, but not against the assembled
  stack. A live Playwright admin e2e (auth + admin-ui preview + seeded admin session) is a
  **documented follow-up**, not a gap in AC coverage.
- **Deferred (non-blocking).** (a) Catalog `(resource, action)` lookups match globally across
  apps (no `appId` namespace) — fine for the 3 non-colliding suite apps today; revisit with an
  app-prefix convention before a 2nd app declares a same-named resource (plan Risk R6).
  (b) No `@vitest/coverage-v8` installed repo-wide (predates 004) — a devops follow-up to wire
  coverage tooling; auth (bun) coverage is 96.4%.
