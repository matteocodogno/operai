/**
 * Bootstrap seed for the authorization domain (T11/T26, specs/004-auth-roles-
 * permissions — refs AC-6.1, AC-6.2, AC-6.3, AC-3.4; plan.md "Bootstrap &
 * seed" + "Catalog registration"; ADR-0007).
 *
 * Independent, idempotent responsibilities, all safe to re-run any number of
 * times (at every deploy, and from tests) — roles + catalog, admin app-access
 * grants (so a bootstrap admin can actually reach the Admin tool), and
 * promoting the configured bootstrap-admin account:
 *
 *   1. {@link seedSystemRoles} — upsert the four system roles `employee`,
 *      `admin`, `accounting`, `hr` (`isSystem: true`, AC-6.2). `isSystem`
 *      roles are never deletable by admins (T8's guard) but remain
 *      editable — an admin may still attach rules to them.
 *   2. {@link seedAppAccessCatalog} — register the suite-wide "can see this
 *      app" catalog via `upsertAppCatalog` (T5): one resource per suite app
 *      that has NOT declared its own full catalog yet (`admin`), keyed by
 *      the app id itself (per `catalog.ts`'s convention for the app-access
 *      resource), each with a single `access` action. This lets an admin
 *      grant/deny app visibility (US-7) from day one, independent of any
 *      app's own domain-resource catalog. `estimai` and `refund` are
 *      deliberately EXCLUDED from this list — see (3)/(4).
 *   3. {@link seedEstimaiCatalog} (T26, AC-3.4) — register EstimAI's FULL
 *      declared catalog (`catalogs/estimai.ts`: app `access` + the
 *      `estimate` resource's view/create/edit/delete actions) via the same
 *      `upsertAppCatalog`. Because `upsertAppCatalog` is a full-replace
 *      upsert keyed by `appId` (`catalog.ts`'s doc comment), registering
 *      `estimai`'s `access` action from BOTH `seedAppAccessCatalog` and
 *      `seedEstimaiCatalog` would mean whichever ran last silently pruned
 *      the other's contribution — a conflicting double-registration. Instead
 *      `estimai` is registered exactly once, here, with its complete
 *      catalog; `seedAppAccessCatalog`'s `SUITE_APPS` list only ever
 *      contains apps that don't (yet) declare more than bare access.
 *   4. {@link seedRefundCatalog} (T2, specs/007-refund-service — AC-1.1,
 *      AC-5.4, AC-7.5, AC-8.2) — register refund's FULL declared catalog
 *      (`catalogs/refund.ts`: app `access` + the `request` resource's
 *      create/read/review/set-approved-total/approve/reject actions) via the
 *      same `upsertAppCatalog`, for the identical reason `estimai` was
 *      pulled out of `SUITE_APPS` in (2): `refund` now declares more than
 *      bare access, so it is registered exactly once, here.
 *   5. {@link seedAccountingRoleGrants} (T2, AC-7.5) — attach the entity-
 *      conditioned review/decision grants to the `accounting` system role
 *      (ADR-0015). Deliberately does NOT touch `employee` (refund access is
 *      fully admin-assigned, Gate-2 decision D2) and does NOT create a
 *      separate `accounting-global` role (Gate-2 decision D3 — "global"
 *      scope is composed by an admin adding an unconditioned grant on top of
 *      this same role, via the resolver's widest-wins union).
 *   6. {@link seedRefundAdminRole} (post-close follow-up, specs/007-refund-
 *      service) — a distinct, explicit `refund-admin` system role bundling
 *      EVERY refund capability at once (`refund:access` + all six `request`
 *      actions), the entity-scoped four (`review`/`set-approved-total`/
 *      `approve`/`reject`) each granted UNCONDITIONED — i.e. global scope via
 *      the resolver's pre-existing widest-wins union, the SAME mechanism
 *      Gate-2 decision D3 already established, just pre-composed into a role
 *      instead of left to a per-admin manual grant. This mirrors, but is
 *      deliberately separate from, `seedAccountingRoleGrants` — it does NOT
 *      create the previously-rejected `accounting-global` role; `refund-admin`
 *      is its own named role an admin opts a specific user into.
 *   7. {@link seedRateAdminGrants} (T1, specs/009-mileage-rate — plan.md
 *      "Architecture §auth", Decision 2) — grants `rate:read` + `rate:manage`
 *      (`catalogs/refund.ts`'s new `rate` resource) to the `admin` and
 *      `refund-admin` system roles. Both actions are UNCONDITIONED in the
 *      catalog itself (no entity scope, unlike `request`'s accounting
 *      actions), so there is no `conditions` payload to attach here either —
 *      unlike `seedAccountingRoleGrants`/`seedRefundAdminRole`, whose grants
 *      populate (or deliberately omit) the ADR-0015 entity condition, a rate
 *      grant is simply present or absent. Deliberately does NOT touch
 *      `employee` or `accounting` — rate configuration is an admin-only
 *      surface, not part of the accounting review workflow.
 *
 * A SEVENTH, per-user concern — assigning the baseline `employee` role (and
 * `admin` for the configured bootstrap email) to every newly created user —
 * is NOT part of this deploy-time seed: it happens once per user, in
 * `auth.config.ts`'s `databaseHooks.user.create.after` hook, via
 * {@link assignBaselineRolesToNewUser} below (also exported from here so the
 * hook stays a thin wire-up and the logic itself is unit-testable directly).
 */

import { ADMIN_ROLE_NAME } from "../admin/lastAdminGuard";
import { db } from "../lib/db";
import { env } from "../lib/env";
import type { Prisma } from "../lib/generated/prisma/client";
import { upsertAppCatalog } from "./catalog";
import { ESTIMAI_CATALOG } from "./catalogs/estimai";
import { REFUND_APP_ID, REFUND_CATALOG } from "./catalogs/refund";

export const EMPLOYEE_ROLE_NAME = "employee";
export const ACCOUNTING_ROLE_NAME = "accounting";
export const REFUND_ADMIN_ROLE_NAME = "refund-admin";

/** The four seed system roles (AC-6.2). Order is insignificant; upserts run sequentially for deterministic logging. */
export const SYSTEM_ROLE_NAMES = [
  EMPLOYEE_ROLE_NAME,
  ADMIN_ROLE_NAME,
  ACCOUNTING_ROLE_NAME,
  "hr",
] as const;

/**
 * Suite apps that get a baseline access-only catalog resource (US-7).
 * `estimai` and `refund` are intentionally NOT here — each declares and
 * registers its own full catalog ({@link seedEstimaiCatalog} T26,
 * {@link seedRefundCatalog} T2), so neither is registered twice with
 * conflicting full-replace payloads. Add an app here only until it ships its
 * own catalog declaration.
 */
export const SUITE_APPS: { appId: string; label: string }[] = [{ appId: "admin", label: "Admin" }];

/**
 * Upserts the four system roles (AC-6.2). Idempotent: re-running never
 * creates duplicates (unique on `Role.name`) and never flips `isSystem`
 * back to `false` for a role an admin might have inspected in between.
 */
export async function seedSystemRoles(): Promise<void> {
  for (const name of SYSTEM_ROLE_NAMES) {
    await db.role.upsert({
      where: { name },
      update: { isSystem: true },
      create: { name, isSystem: true },
    });
  }
}

/**
 * Registers the app-access catalog for every suite app (US-7). Idempotent:
 * `upsertAppCatalog` is itself a full-replace upsert keyed by `appId`, so
 * re-running with the same `SUITE_APPS` list is a no-op on the resulting
 * state.
 */
export async function seedAppAccessCatalog(): Promise<void> {
  for (const app of SUITE_APPS) {
    await upsertAppCatalog({
      appId: app.appId,
      resources: [
        {
          key: app.appId,
          label: app.label,
          actions: [{ key: "access", label: "Access", supportedConditions: [] }],
        },
      ],
    });
  }
}

/**
 * Registers EstimAI's full declared catalog (T26, AC-3.4) — `catalogs/
 * estimai.ts`'s `ESTIMAI_CATALOG` (app `access` + the `estimate` resource's
 * view/create/edit/delete actions, each with the ownership/entity/department
 * conditions model). Idempotent for the same reason `seedAppAccessCatalog`
 * is: `upsertAppCatalog` is itself a full-replace upsert keyed by `appId`.
 */
export async function seedEstimaiCatalog(): Promise<void> {
  await upsertAppCatalog(ESTIMAI_CATALOG);
}

/**
 * Registers refund's full declared catalog (T2, specs/007-refund-service —
 * AC-1.1, AC-5.4, AC-7.5, AC-8.2) — `catalogs/refund.ts`'s `REFUND_CATALOG`
 * (app `access` + the `request` resource's create/read/review/
 * set-approved-total/approve/reject actions, each with its declared
 * `supportedConditions`). Idempotent for the same reason `seedEstimaiCatalog`
 * is: `upsertAppCatalog` is itself a full-replace upsert keyed by `appId`.
 */
export async function seedRefundCatalog(): Promise<void> {
  await upsertAppCatalog(REFUND_CATALOG);
}

/** Every suite app id. `estimai`/`refund` declare their own catalogs; the rest come from SUITE_APPS. */
export const ALL_APP_IDS: readonly string[] = [
  "estimai",
  REFUND_APP_ID,
  ...SUITE_APPS.map((a) => a.appId),
];

/**
 * The entity attribute condition (specs/004, applied by ADR-0015): "the
 * record's entity must equal the acting user's `entity` attribute". Attached
 * to every entity-scoped `accounting` grant below.
 */
const REFUND_ENTITY_CONDITION = { attributes: [{ key: "entity", match: "user" }] };

/** The `request` resource actions the `accounting` role is granted, entity-scoped (ADR-0015). */
const ACCOUNTING_REQUEST_ACTIONS = ["review", "set-approved-total", "approve", "reject"] as const;

/**
 * Seeds the `accounting` role's refund grants (T2, specs/007-refund-service
 * — AC-5.4, AC-6.4, AC-7.5; plan.md "Role → permission mapping"; ADR-0015).
 * Grants `refund:access` (unconditional — same shape as every other app-
 * access grant) plus `request:review`/`set-approved-total`/`approve`/
 * `reject`, each carrying the entity condition {@link REFUND_ENTITY_CONDITION}
 * — an `accounting` user is scoped to their own `user.entity`. Deliberately
 * does NOT touch:
 *   - `employee` — refund access is fully admin-assigned (Gate-2 decision
 *     D2); an employee gets `refund:access`/`request:create`/`request:read`
 *     only once an admin grants them via the existing specs/004 GUI.
 *   - a separate `accounting-global` role — "global" (both-entity) review
 *     scope is composed by an admin additionally granting an UNCONDITIONED
 *     `request:review` (etc.) to a user who already holds this role; the
 *     resolver's pre-existing widest-wins union promotes them to global with
 *     no second role needed (Gate-2 decision D3; ADR-0015 point 4).
 * Idempotent: each (role, resource, action) grant is created only when
 * absent, mirroring {@link seedAdminRoleGrants}'s pattern exactly.
 */
export async function seedAccountingRoleGrants(): Promise<void> {
  const accountingRole = await db.role.upsert({
    where: { name: ACCOUNTING_ROLE_NAME },
    update: {},
    create: { name: ACCOUNTING_ROLE_NAME, isSystem: true },
  });

  const existingAccess = await db.permissionRule.findFirst({
    where: { roleId: accountingRole.id, resource: REFUND_APP_ID, action: "access" },
  });
  if (!existingAccess) {
    await db.permissionRule.create({
      data: { roleId: accountingRole.id, resource: REFUND_APP_ID, action: "access" },
    });
  }

  for (const action of ACCOUNTING_REQUEST_ACTIONS) {
    const existing = await db.permissionRule.findFirst({
      where: { roleId: accountingRole.id, resource: "request", action },
    });
    if (!existing) {
      await db.permissionRule.create({
        data: {
          roleId: accountingRole.id,
          resource: "request",
          action,
          conditions: REFUND_ENTITY_CONDITION as Prisma.InputJsonValue,
        },
      });
    }
  }
}

/** The `request` resource actions the `refund-admin` role is granted — ALL six, every one UNCONDITIONED (global). */
const REFUND_ADMIN_REQUEST_ACTIONS = [
  "create",
  "read",
  "review",
  "set-approved-total",
  "approve",
  "reject",
] as const;

/**
 * Seeds the `refund-admin` role (post-close follow-up, specs/007-refund-
 * service — "assign everything at once"): one role that grants EVERY refund
 * capability, unconditioned, to whoever an admin assigns it to. Grants
 * `refund:access` plus all six `request` actions — `create`/`read` the same
 * way every grant of theirs already is (the catalog declares no supported
 * condition for `create`, and `read`'s ownership check is enforced in code
 * regardless of any condition value, so omitting `conditions` here changes
 * nothing observable for those two) — and, deliberately, `review`/
 * `set-approved-total`/`approve`/`reject` ALSO with no `conditions` row.
 *
 * That last part is a semantics decision, not a style choice: `refund-api`'s
 * `canReadRequest` (requests.service.ts) only lets a NON-owner read a request
 * via the `request:review` branch — an unconditioned `request:read` grant
 * alone does NOT let this role read another user's request (`GET /requests`
 * is hard-scoped to `listOwnRequests(sub)` regardless of any grant, and
 * `GET /requests/:id`'s owner branch requires ownership AND `read`, so a
 * non-owner `read` grant is inert there). Reading/deciding ANY request in
 * ANY entity — the "true refund superuser" requirement — is achieved ONLY
 * by granting `request:review` (and the three decision actions) with NO
 * entity condition, which `entityScopeForPermission` (conditions.ts) then
 * resolves to `GLOBAL_ENTITY_SCOPE`: `canReadRequest`'s accounting branch,
 * the review queue (`GET /review/requests`), and every decide route
 * (approve/reject/set-approved-total, `decide.routes.ts`) all accept that
 * scope for every request regardless of owner or entity (ADR-0015's
 * pre-existing widest-wins union — the SAME mechanism Gate-2 decision D3
 * already established for a manually-composed "global" accounting grant,
 * here pre-bundled into a role instead of left to a one-off admin action).
 * `request:read` is still granted (matching the catalog's full action set,
 * so admin-ui's rule composer shows this role holding it) but is NOT what
 * makes cross-user reads work — see the paragraph above.
 *
 * Deliberately does NOT create an `accounting-global` role (Gate-2 decision
 * D3, reaffirmed by {@link seedAccountingRoleGrants}'s doc comment) —
 * `refund-admin` is a distinct, explicitly-named role, not that rejected
 * shape. Idempotent: each (role, resource, action) grant is created only
 * when absent, mirroring {@link seedAccountingRoleGrants}'s pattern exactly.
 */
export async function seedRefundAdminRole(): Promise<void> {
  const refundAdminRole = await db.role.upsert({
    where: { name: REFUND_ADMIN_ROLE_NAME },
    update: {},
    create: {
      name: REFUND_ADMIN_ROLE_NAME,
      description: "Refund Admin — every refund capability, across all entities",
      isSystem: true,
    },
  });

  const existingAccess = await db.permissionRule.findFirst({
    where: { roleId: refundAdminRole.id, resource: REFUND_APP_ID, action: "access" },
  });
  if (!existingAccess) {
    await db.permissionRule.create({
      data: { roleId: refundAdminRole.id, resource: REFUND_APP_ID, action: "access" },
    });
  }

  for (const action of REFUND_ADMIN_REQUEST_ACTIONS) {
    const existing = await db.permissionRule.findFirst({
      where: { roleId: refundAdminRole.id, resource: "request", action },
    });
    if (!existing) {
      // Omit `conditions` → defaults to null (an unconditional grant) for
      // EVERY action, including the four ADR-0015 entity-scoped ones — see
      // this function's doc comment for why that's required, not incidental.
      await db.permissionRule.create({
        data: { roleId: refundAdminRole.id, resource: "request", action },
      });
    }
  }
}

/** The `rate` resource's two actions (T1, specs/009-mileage-rate) — both UNCONDITIONED. */
const RATE_ACTIONS = ["read", "manage"] as const;

/** The system roles granted `rate:read`/`rate:manage` (T1, specs/009-mileage-rate). */
const RATE_ADMIN_ROLE_NAMES = [ADMIN_ROLE_NAME, REFUND_ADMIN_ROLE_NAME] as const;

/**
 * Seeds `rate:read`/`rate:manage` grants (T1, specs/009-mileage-rate —
 * plan.md "Architecture §auth", Decision 2) onto the `admin` and
 * `refund-admin` system roles. `catalogs/refund.ts`'s `rate` resource
 * declares both actions with NO `supportedConditions` — a deliberate
 * contrast with `request`'s entity-scoped accounting actions (ADR-0015) —
 * so, unlike {@link seedAccountingRoleGrants}/{@link seedRefundAdminRole},
 * there is no `conditions` payload to compute here; each grant is either
 * present or absent. Mirrors {@link seedRefundAdminRole}'s upsert-then-check
 * pattern exactly. Idempotent: each (role, resource, action) grant is
 * created only when absent. Deliberately does NOT touch `employee` or
 * `accounting` — rate configuration is an admin-only surface.
 */
export async function seedRateAdminGrants(): Promise<void> {
  for (const roleName of RATE_ADMIN_ROLE_NAMES) {
    const role = await db.role.upsert({
      where: { name: roleName },
      update: {},
      create: { name: roleName, isSystem: true },
    });

    for (const action of RATE_ACTIONS) {
      const existing = await db.permissionRule.findFirst({
        where: { roleId: role.id, resource: "rate", action },
      });
      if (!existing) {
        await db.permissionRule.create({
          data: { roleId: role.id, resource: "rate", action },
        });
      }
    }
  }
}

/**
 * Grants the `admin` role `access` to every suite app (US-7). WITHOUT this the
 * seed leaves `admin` with zero permission rules, so even the bootstrap admin
 * resolves to `apps: []` and is stranded on the shell's `/no-access` screen —
 * unable to reach the very Admin tool needed to grant anyone (themselves
 * included) anything. So `admin` must be able to see the whole suite out of the
 * box. Employees deliberately get NO default grants — app access is fully
 * admin-assigned (product decision, specs/004). Idempotent: each
 * (role, resource, action) grant is created only when absent.
 */
export async function seedAdminRoleGrants(): Promise<void> {
  const adminRole = await db.role.upsert({
    where: { name: ADMIN_ROLE_NAME },
    update: {},
    create: { name: ADMIN_ROLE_NAME, isSystem: true },
  });
  for (const appId of ALL_APP_IDS) {
    const existing = await db.permissionRule.findFirst({
      where: { roleId: adminRole.id, resource: appId, action: "access" },
    });
    if (!existing) {
      // Omit `conditions` → defaults to null (an unconditional grant); app
      // `access` declares no supported conditions anyway.
      await db.permissionRule.create({
        data: { roleId: adminRole.id, resource: appId, action: "access" },
      });
    }
  }
}

/**
 * Idempotently ensures the configured `BOOTSTRAP_ADMIN_EMAIL` account (if it
 * already exists) holds the `admin` role, and bumps its permission epoch.
 * Complements the create-time hook ({@link assignBaselineRolesToNewUser}) which
 * only fires on NEW users — so an admin who signed in BEFORE the env var was
 * configured is still promoted on the next deploy/seed, with no manual DB
 * surgery. No-op when the var is unset or the user doesn't exist yet. Email
 * match is case-insensitive against the OAuth-verified address.
 */
export async function ensureBootstrapAdmin(): Promise<void> {
  const bootstrapEmail = env.BOOTSTRAP_ADMIN_EMAIL;
  if (!bootstrapEmail) return;
  const user = await db.user.findFirst({
    where: { email: { equals: bootstrapEmail, mode: "insensitive" } },
    select: { id: true },
  });
  if (!user) return;
  const adminRole = await db.role.upsert({
    where: { name: ADMIN_ROLE_NAME },
    update: {},
    create: { name: ADMIN_ROLE_NAME, isSystem: true },
  });
  await db.userRole.upsert({
    where: { userId_roleId: { userId: user.id, roleId: adminRole.id } },
    update: {},
    create: { userId: user.id, roleId: adminRole.id },
  });
  await db.user.update({
    where: { id: user.id },
    data: { permissionEpoch: { increment: 1 } },
  });
}

/** Runs every deploy-time seed step (all idempotent). */
export async function seed(): Promise<void> {
  await seedSystemRoles();
  await seedAppAccessCatalog();
  await seedEstimaiCatalog();
  await seedRefundCatalog();
  await seedAdminRoleGrants();
  await seedAccountingRoleGrants();
  await seedRefundAdminRole();
  await seedRateAdminGrants();
  await ensureBootstrapAdmin();
}

// ─── Per-user baseline role assignment (AC-6.1, AC-6.3) ─────────────────────

/** The minimal shape this needs from a better-auth `User`. */
export interface NewUserForBootstrap {
  id: string;
  email: string;
  emailVerified?: boolean;
}

/**
 * Assigns baseline roles to a newly created user. Called from
 * `auth.config.ts`'s `databaseHooks.user.create.after` — i.e. once per
 * sign-up, for every provider (Google, GitHub, and the dev-only test-auth
 * mint path), never from anything a client directly triggers.
 *
 *   - Every new user gets `employee` (AC-6.3).
 *   - A user whose email matches the configured `BOOTSTRAP_ADMIN_EMAIL`
 *     ALSO gets `admin` (AC-6.1). The comparison is against `user.email` as
 *     recorded by better-auth from the OAuth provider's verified profile —
 *     never anything a request body/header could influence — and is
 *     additionally gated on `emailVerified` being `true` so a hypothetical
 *     future unverified-email signup path can never self-claim the
 *     bootstrap identity by matching the address alone.
 *
 * Role rows are upserted defensively here (not just assumed present from
 * {@link seedSystemRoles}) so this hook is safe even if it fires before the
 * deploy-time seed has ever run (e.g. a fresh test DB). Assignment itself
 * uses `userRole.upsert` on the `(userId, roleId)` composite key, so calling
 * this twice for the same user (it never should, but hooks firing more than
 * once is a cheaper failure mode than a duplicate-key crash) stays a no-op.
 */
export async function assignBaselineRolesToNewUser(
  user: NewUserForBootstrap,
): Promise<void> {
  const employeeRole = await db.role.upsert({
    where: { name: EMPLOYEE_ROLE_NAME },
    update: {},
    create: { name: EMPLOYEE_ROLE_NAME, isSystem: true },
  });
  await db.userRole.upsert({
    where: { userId_roleId: { userId: user.id, roleId: employeeRole.id } },
    update: {},
    create: { userId: user.id, roleId: employeeRole.id },
  });

  const bootstrapEmail = env.BOOTSTRAP_ADMIN_EMAIL;
  const isBootstrapAdmin =
    bootstrapEmail !== undefined &&
    user.emailVerified === true &&
    user.email.toLowerCase() === bootstrapEmail.toLowerCase();

  if (isBootstrapAdmin) {
    const adminRole = await db.role.upsert({
      where: { name: ADMIN_ROLE_NAME },
      update: {},
      create: { name: ADMIN_ROLE_NAME, isSystem: true },
    });
    await db.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: adminRole.id } },
      update: {},
      create: { userId: user.id, roleId: adminRole.id },
    });
  }
}

// ─── Standalone entrypoint (`bun run db:seed`) ───────────────────────────────
// Lets the deploy-time seed run as its own process (e.g. a Railway
// preDeployCommand step, alongside the existing `bun run db:deploy`), in
// addition to being imported directly by tests.
if (import.meta.main) {
  seed()
    .then(() => {
      console.log(
        "Seeded system roles + suite app-access catalog + EstimAI catalog + refund catalog " +
          "+ admin app-access grants + accounting refund grants + refund-admin role + " +
          "rate admin grants + bootstrap admin",
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error("Seed failed:", err);
      process.exit(1);
    });
}
