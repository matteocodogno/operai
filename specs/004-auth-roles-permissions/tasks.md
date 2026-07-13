---
spec: 004
generated: 2026-07-13
---

# Tasks: Authorization — roles, departments & fine-grained permissions

Tracks: **A** auth-service authz core (backend-dev) · **B** new `admin-ui` remote
(frontend-dev) · **C** shell US-7 (frontend-dev) · **D** EstimAI catalog (backend/frontend)
· **E** infra (devops). Tasks with no `deps:` edge between them are parallelizable.

## Track A — auth service authorization core

- [x] T1: Prisma schema + migration for the authz domain — refs: US-1/2/3/5, AC-4.2 — deps: none
  - touch: `auth/prisma/schema.prisma`, new `auth/prisma/migrations/*`
  - add models `role`, `department`, `permission_rule` (resource, action, `conditions Json?`),
    `user_role`, `department_role`, `user_department`, `catalog_resource`, `catalog_action`,
    `audit_log`; add `user.permissionEpoch Int @default(0)`, `user.entity String?`,
    `user.jobTitle String?`. cuid PKs, `@@map` lowercase, cascade-from-`user`, timestamps.
  - done when: `bun run db:migrate` applies cleanly on the existing DB; client regenerates; never edits `20260415155105_init`.
- [x] T2: Effective-permissions resolver — refs: AC-4.2, AC-4.4 — deps: T1
  - touch: `auth/src/authz/resolver.ts` (+ `resolver.test.ts`)
  - union of direct `user_role` ∪ department-derived rules, de-dup by `(resource,action)` (widest condition wins); default-deny (absent = no grant); epoch helpers (bump affected users).
  - done when: unit tests cover union, dedup/widest-wins, default-deny.
- [x] T3: JWT `definePayload` claim — refs: AC-4.3, plan R2 — deps: T1
  - touch: `auth/src/auth/auth.config.ts`
  - replace the dead `jwt.fields` with `definePayload` → `{ email, name, image, perm_epoch }`; keep `sub` via plugin default (never change `sub`).
  - done when: contract test asserts the minted token still yields `sub`+`email` (verified by estimai-api's verifier path) and carries `perm_epoch`.
- [x] T4: `requireAdmin` middleware — refs: AC-1.5 — deps: T1, T2
  - touch: `auth/src/auth/auth.middleware.ts` (or `authz/`)
  - reads `c.get("user")`, checks the `admin` role; `403` RFC 7807 otherwise.
  - done when: integration test — non-admin → 403 on a guarded route; admin passes.
- [x] T5: Permission catalog — refs: AC-3.1, AC-3.2 — deps: T1, T4
  - touch: `auth/src/authz/catalog.routes.ts` + catalog module; mount in `src/index.ts`; OpenAPI tag
  - `PUT /authz/catalog` (idempotent upsert of an app's resources/actions/condition-types), `GET /admin/catalog`.
  - done when: register a catalog → `GET /admin/catalog` returns it; off-catalog validation helper exists.
- [x] T6: `GET /authz/me` — refs: AC-4.1, AC-3.3, AC-4.4 — deps: T2
  - touch: `auth/src/authz/authz.routes.ts`
  - returns `{ epoch, apps, roles, departments, permissions:[{resource,action,conditions}] }` for the caller; `apps` = `access`-granted resources.
  - done when: integration test returns enumerable perms + `apps`; absent pair not present.
- [x] T7: Audit trail — refs: AC-5.1, AC-5.2, AC-5.3 — deps: T1
  - touch: `auth/src/authz/audit.ts` + `GET /admin/audit`
  - transactional helper: write `audit_log` row (actor/target/summary/diff) **and** bump affected `permissionEpoch` in one tx; paginated read-only list; no update/delete route.
  - done when: a mutation produces an immutable audit row; `GET /admin/audit` paginates; no mutate route exists.
- [ ] T8: Admin roles API — refs: AC-1.1, AC-2.1–2.4, AC-3.2 — deps: T4, T5, T7
  - touch: `auth/src/admin/admin.routes.ts` (roles)
  - `GET/POST /admin/roles`, `GET/PATCH/DELETE /admin/roles/:id` (delete `isSystem` → 422), `PUT /admin/roles/:id/rules` (catalog-validated → 422; conditions ∈ `supportedConditions`).
  - done when: integration tests incl off-catalog 422, system-role delete 422, custom-role create+rules; each mutation audits + bumps epoch.
- [x] T9: Admin departments API — refs: AC-1.2 — deps: T4, T7
  - touch: `auth/src/admin/admin.routes.ts` (departments)
  - `GET/POST /admin/departments`, `GET/PATCH/DELETE /:id` (**`GET /:id` embeds members** — drift fix), `PUT /:id/roles`, `PUT /:id/members` (drift fix).
  - done when: create dept + add members + confer roles → members inherit (verified via a member's `/authz/me`).
- [x] T10: Admin users API — refs: AC-1.3, AC-1.4, AC-2.3, AC-6.4 — deps: T4, T2, T7
  - touch: `auth/src/admin/admin.routes.ts` (users)
  - `GET /admin/users` (paginated + `?q=` — drift fix), `GET /admin/users/:id`, `PATCH /admin/users/:id` (entity/jobTitle), `PUT /admin/users/:id/roles` · `/departments`, `GET /admin/users/:id/permissions` (drift fix — resolver output for any user); **last-admin guard → 422**.
  - done when: assign/revoke reflected in target's `/authz/me`; last-admin removal → 422; each mutation audits + bumps epoch.
- [x] T11: Seed roles + bootstrap admin — refs: AC-6.1, AC-6.2, AC-6.3 — deps: T1, T5
  - touch: `auth/src/lib/env.ts` (`BOOTSTRAP_ADMIN_EMAIL`), `auth/.env.example`, seed script, `auth.config.ts` `databaseHooks.user.create.after`
  - seed `employee`/`admin`/`accounting`/`hr` (+ their catalogs); on user-create assign `employee`, and `admin` if email matches bootstrap.
  - done when: fresh-DB integration test → 4 system roles exist; bootstrap email → admin; every new user → employee.
- [x] T12: Align better-auth version + hygiene — refs: plan R8 — deps: none
  - touch: `auth/package.json` (`better-auth` `^1.6.2` to match the lockfile)
  - done when: `bun install` clean; `bun test` (auth) green; `definePayload`/`databaseHooks` behave as on 1.6.2.

## Track B — new `admin-ui` federated remote

- [x] T13: Scaffold `admin-ui` remote — refs: US-1 (host), ADR-0006 — deps: none
  - touch: `admin-ui/*` (package.json, vite.config.ts w/ federation exposing `./App` + consuming `shell/session`+`shell/tokens.css`, index.html, `src/main.tsx` standalone bootstrap, `src/App.tsx`, `.env.example`, vitest/playwright config) — mirror `refund-ui`.
  - done when: `pnpm --dir admin-ui build` emits `remoteEntry.js`; standalone bootstrap runs.
- [x] T14: admin-ui inner router + section nav — refs: US-1 — deps: T13
  - touch: `admin-ui/src/router.tsx` (basepath `/admin`), `App.tsx`, section nav (Roles/Departments/Users/Audit), not-found.
  - done when: the four sections route client-side under `/admin`.
- [x] T15: admin-ui shared primitives (ported patterns) — refs: design a11y — deps: T13
  - touch: `admin-ui/src/components/*` — ConfirmDeleteModal (D1, `role="alertdialog"`), error banner (RFC 7807), SkeletonListRows, **Pagination** (new primitive), badges (System + condition chips), GuardrailDialog (D2, acknowledge-only).
  - done when: component tests for the dialogs (focus trap, Escape) + pagination bounds.
- [x] T16: admin-ui API client — refs: AC-4.1, all admin ACs — deps: T13
  - touch: `admin-ui/src/lib/adminApi.ts` — typed calls to `/admin/*` + `/authz/me` via `apiFetch` from `shell/session`; RFC 7807 error mapping.
  - done when: typed client + unit tests against the plan's contract shapes.
- [ ] T17: Roles list (A1) + Create-role modal (M1) — refs: AC-1.1, AC-2.4 — deps: T14, T15, T16
  - done when: list renders (loading/empty/populated/error); create → role editor; system badge + disabled delete.
- [ ] T18: Role editor + rule composer (A2) — refs: AC-2.1–2.4, AC-3.1, AC-3.2 — deps: T14, T15, T16
  - touch: `admin-ui/src/pages/RoleEditor.tsx` + composer
  - catalog-driven Resource→Action cascade (only catalog options), dynamic Conditions fieldset (ownership radio + attribute checkboxes per `supportedConditions`) with `aria-live` announcements; save via `PUT /admin/roles/:id/rules`; 422 stale-catalog banner + reload.
  - done when: component/e2e — build a conditioned rule; off-catalog impossible via UI; a11y aria-live on change.
- [ ] T19: Departments list + detail (B1/B2) — refs: AC-1.2 — deps: T14, T15, T16
  - done when: create dept, confer roles, add/remove members (user-search picker); guardrail/errors surfaced.
- [ ] T20: Users list + detail (C1/C2) — refs: AC-1.3, AC-1.4, AC-2.3, AC-6.4 — deps: T14, T15, T16
  - done when: search+pagination; edit entity/jobTitle; assign roles/departments; last-admin 422 → GuardrailDialog D2 preserving the edit.
- [x] T21: Audit log screen (D1) — refs: AC-5.2, AC-5.3 — deps: T14, T15, T16
  - done when: paginated reverse-chron table + row-expand diff; no mutate affordance.
- [x] T22: Permission-denied in-place (E1) — refs: AC-1.5 — deps: T14, T15
  - done when: an admin `403` renders E1 in-place (no crash, no Retry), chrome intact.

## Track C — shell US-7 (app-access enforcement)

- [x] T23: shell/session permission resolution — refs: AC-4.3, AC-7.5 — deps: none (builds to the `/authz/me` contract)
  - touch: `shell/src/lib/session.ts` — `ensurePermissions()`/`usePermissions()` (fetch `/authz/me`, in-memory cache per ADR-0001, cleared on `signOut`), revalidate helper.
  - done when: unit tests — cache, clear-on-signout, revalidate returns fresh apps/permissions.
- [x] T24: Sidebar/tools app-access filter + Admin tool — refs: AC-7.1, AC-7.2 — deps: T23
  - touch: `shell/src/lib/tools.ts` (`ToolId += 'admin'`, TOOLS entry), `shell/src/components/Sidebar.tsx` (filter by `apps` + `TOOL_ICONS` admin entry).
  - done when: component/e2e — nav lists only `apps`-granted tools; Admin appears for admins only.
- [x] T25: shell route guard + `/no-access` + admin remote wiring — refs: AC-7.3, AC-7.4, AC-7.5 — deps: T23, T24, T13
  - touch: `shell/src/router.tsx` (per-tool `access` `beforeLoad`; `/no-access` route S1; `/admin/$` route), `shell/src/federation/remotes.d.ts` (`admin/App`), `shell/vite.config.ts` (`ADMIN_REMOTE_URL` remote), `shell/src/index.css` (`@source` admin-ui), `shell/vercel.json` (CSP admin origin).
  - done when: e2e — deep-link to an un-permitted tool → redirect/`/no-access`; zero-apps user → S1; revoked app gone on next navigation.

## Track D — EstimAI catalog declaration

- [ ] T26: EstimAI declares + registers its catalog — refs: AC-3.4 — deps: T5
  - touch: estimai catalog declaration (`estimai-api`/`estimai-ui`) + registration via seed/`PUT /authz/catalog`.
  - done when: `GET /admin/catalog` includes `estimai` (`estimate` → view/create/edit/delete + app `access`). Declaration only — no enforcement (non-goal).

## Track E — infra / deploy

- [x] T27: admin-ui deploy wiring — refs: ADR-0006 deploy — deps: T13, T25
  - touch: `admin-ui/vercel.json` (SPA rewrites, CSP, remoteEntry/asset headers), `infra/variables.md` + `infra/vercel-deploy-runbook.md` (`ADMIN_REMOTE_URL`, `BOOTSTRAP_ADMIN_EMAIL`, admin origin in shell CSP / auth `ALLOWED_ORIGINS` / apiFetch trusted origins).
  - done when: docs + config added; consistent with the existing runbooks.

## Close

- [ ] T28: All gates green → `done` — deps: T1–T27
  - QE PASS (+ owasp-reviewer, security-sensitive) + eval PASS + all tasks checked → set spec `status: done`.

---

## Coverage map (every AC → task)

AC-1.1 T8,T17 · AC-1.2 T9,T19 · AC-1.3 T10,T20 · AC-1.4 T10,T20 · AC-1.5 T4,T22,T25 ·
AC-2.1 T8,T18 · AC-2.2 T8,T18 · AC-2.3 T8/T10,T18/T20 · AC-2.4 T8,T17 ·
AC-3.1 T5,T18 · AC-3.2 T5/T8,T18 · AC-3.3 T6 · AC-3.4 T26 ·
AC-4.1 T6 · AC-4.2 T2 · AC-4.3 T3+T10+T23 · AC-4.4 T2,T6 ·
AC-5.1 T7,T8/T9/T10 · AC-5.2 T7,T21 · AC-5.3 T7,T21 ·
AC-6.1 T11 · AC-6.2 T11 · AC-6.3 T11 · AC-6.4 T10,T20 ·
AC-7.1 T24 · AC-7.2 T24 · AC-7.3 T25 · AC-7.4 T25 · AC-7.5 T23,T25.

Every AC is covered; every task serves ≥1 AC (T12 hygiene/R8, T13–T16/T27 are enabling
infrastructure for the AC-bearing tasks).
