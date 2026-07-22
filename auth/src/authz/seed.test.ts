/**
 * Tests for the bootstrap seed (T11/T26, specs/004-auth-roles-permissions —
 * refs AC-6.1, AC-6.2, AC-6.3, AC-3.4).
 *
 * Strategy: everything here is exercised directly against the real local
 * Postgres (shared dev DB, localhost:5435) via `db`/`env`/`./seed` only —
 * deliberately NOT via `auth.config`/`better-auth`/`testAuthRouter`.
 *
 * `seed.ts` has no import of `../auth/auth.config` for exactly this reason:
 * several sibling files in THIS directory (`audit.routes.test.ts`,
 * `authz.routes.test.ts`, `catalog.routes.test.ts`) — and `admin/*.routes
 * .test.ts` — call `mock.module("../auth/auth.config", ...)` to stub
 * `sessionMiddleware`'s dependency. Bun's `mock.module` override is keyed
 * by the literal specifier text used to register it; `"../auth/auth.config"`
 * is the exact string every same-depth sibling directory (`admin/`,
 * `authz/`, `test-auth/`) would ALSO use to reach it, and empirically that
 * collides across files in a full repo-wide `bun test` run (confirmed while
 * writing this test — a `testAuthRouter`-based mint from this directory
 * reliably got the MOCKED `auth.config` because some earlier sibling file's
 * `mock.module` call had already registered under that identical string).
 * `src/auth/jwt-claims.contract.test.ts` and `src/auth/auth.config.test.ts`
 * escape this because they resolve the same target via `"./auth.config"` —
 * a different literal string — which is also why the ONE test that proves
 * `auth.config.ts`'s `databaseHooks.user.create.after` is actually wired to
 * {@link assignBaselineRolesToNewUser} (rather than just proving the
 * function works in isolation) lives in `src/auth/auth.config.test.ts`, not
 * here. Everything below only needs `db`/`env`/`seed.ts`'s exports, which
 * never touch `auth.config`, so this file is immune to that hazard and safe
 * to run in any position within a full `bun test`.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { ADMIN_ROLE_NAME } from "../admin/lastAdminGuard";
import { db } from "../lib/db";
import { env } from "../lib/env";
import { getAppCatalog } from "./catalog";
import { ESTIMAI_APP_ID } from "./catalogs/estimai";
import { REFUND_APP_ID } from "./catalogs/refund";
import {
  ACCOUNTING_ROLE_NAME,
  ALL_APP_IDS,
  assignBaselineRolesToNewUser,
  EMPLOYEE_ROLE_NAME,
  ensureBootstrapAdmin,
  REFUND_ADMIN_ROLE_NAME,
  seed,
  seedAccountingRoleGrants,
  seedAdminRoleGrants,
  seedAppAccessCatalog,
  seedEstimaiCatalog,
  seedRateAdminGrants,
  seedRefundAdminRole,
  seedRefundCatalog,
  seedSettingsAdminGrants,
  seedSystemRoles,
  SUITE_APPS,
  SYSTEM_ROLE_NAMES,
} from "./seed";

const RUN_ID = crypto.randomUUID().slice(0, 8);

async function userHasRole(userId: string, roleName: string): Promise<boolean> {
  const row = await db.userRole.findFirst({
    where: { userId, role: { name: roleName } },
  });
  return row !== null;
}

function setBootstrapEmail(email: string | undefined): void {
  (env as unknown as Record<string, unknown>)["BOOTSTRAP_ADMIN_EMAIL"] = email;
}

// ─── Deploy-time seed ─────────────────────────────────────────────────────────

describe("seedSystemRoles (T11, AC-6.2)", () => {
  test("creates exactly the 4 system roles, all isSystem, idempotent on re-run", async () => {
    await seedSystemRoles();
    await seedSystemRoles(); // re-run — must be a no-op on the resulting state

    const roles = await db.role.findMany({
      where: { name: { in: [...SYSTEM_ROLE_NAMES] } },
    });

    expect(roles).toHaveLength(4);
    expect(roles.map((r) => r.name).sort()).toEqual([
      "accounting",
      "admin",
      "employee",
      "hr",
    ]);
    for (const role of roles) {
      expect(role.isSystem).toBe(true);
    }
  });
});

describe("seedAppAccessCatalog (T11, US-7)", () => {
  test("registers a single access-only resource for admin, idempotent on re-run", async () => {
    await seedAppAccessCatalog();
    await seedAppAccessCatalog(); // re-run — full-replace upsert, must not duplicate

    for (const appId of ["admin"]) {
      const catalog = await getAppCatalog(appId);
      const accessResource = catalog.resources.find((r) => r.key === appId);
      expect(accessResource).toBeDefined();
      expect(accessResource?.actions).toHaveLength(1);
      expect(accessResource?.actions[0]?.key).toBe("access");
    }
  });

  test("estimai is excluded from SUITE_APPS — it declares/registers its own full catalog (T26), not this one", () => {
    // This is a code-shape assertion, not a DB-state one, so it stays true
    // regardless of what earlier test runs may have left in the shared DB.
    expect(SUITE_APPS.some((app) => app.appId === "estimai")).toBe(false);
  });

  test("refund is excluded from SUITE_APPS (T2, specs/007) — it declares/registers its own full catalog, not this one", () => {
    expect(SUITE_APPS.some((app) => app.appId === "refund")).toBe(false);
  });
});

describe("seedEstimaiCatalog (T26, AC-3.4)", () => {
  test("registers EstimAI's full catalog — app access + estimate view/create/edit/delete, idempotent on re-run", async () => {
    await seedEstimaiCatalog();
    await seedEstimaiCatalog(); // re-run — full-replace upsert, must not duplicate

    const catalog = await getAppCatalog(ESTIMAI_APP_ID);

    const accessResource = catalog.resources.find((r) => r.key === ESTIMAI_APP_ID);
    expect(accessResource).toBeDefined();
    expect(accessResource?.actions).toHaveLength(1);
    expect(accessResource?.actions[0]?.key).toBe("access");

    const estimateResource = catalog.resources.find((r) => r.key === "estimate");
    expect(estimateResource).toBeDefined();
    expect(estimateResource?.actions.map((a) => a.key).sort()).toEqual([
      "create",
      "delete",
      "edit",
      "view",
    ]);
    for (const action of estimateResource?.actions ?? []) {
      expect(action.supportedConditions.sort()).toEqual(["department", "entity", "ownership"]);
    }
  });

  test("GET /admin/catalog's backing read (getFullCatalog) includes estimai's estimate resource (AC-3.4 done-when)", async () => {
    await seedEstimaiCatalog();

    const { getFullCatalog } = await import("./catalog");
    const fullCatalog = await getFullCatalog();

    const mine = fullCatalog.find((app) => app.appId === ESTIMAI_APP_ID);
    expect(mine).toBeDefined();
    const estimateResource = mine?.resources.find((r) => r.key === "estimate");
    expect(estimateResource).toBeDefined();
    expect(estimateResource?.actions).toHaveLength(4);
  });
});

// ─── T2, specs/007-refund-service ───────────────────────────────────────────

describe("seedRefundCatalog (T2, specs/007-refund-service — AC-1.1, AC-5.4, AC-7.5, AC-8.2)", () => {
  test("registers refund's full catalog — app access + request create/read/review/set-approved-total/approve/reject, idempotent on re-run", async () => {
    await seedRefundCatalog();
    await seedRefundCatalog(); // re-run — full-replace upsert, must not duplicate

    const catalog = await getAppCatalog(REFUND_APP_ID);

    const accessResource = catalog.resources.find((r) => r.key === REFUND_APP_ID);
    expect(accessResource).toBeDefined();
    expect(accessResource?.actions).toHaveLength(1);
    expect(accessResource?.actions[0]?.key).toBe("access");
    expect(accessResource?.actions[0]?.supportedConditions).toEqual([]);

    const requestResource = catalog.resources.find((r) => r.key === "request");
    expect(requestResource).toBeDefined();
    expect(requestResource?.actions.map((a) => a.key).sort()).toEqual(
      ["approve", "create", "read", "reject", "review", "set-approved-total"].sort(),
    );

    const byKey = new Map(requestResource?.actions.map((a) => [a.key, a.supportedConditions]));
    expect(byKey.get("create")).toEqual([]);
    expect(byKey.get("read")).toEqual(["ownership"]);
    expect(byKey.get("review")).toEqual(["entity"]);
    expect(byKey.get("set-approved-total")).toEqual(["entity"]);
    // `approve` additionally declares `self-approval` (specs/010, T1,
    // AC-5.1; ADR-0026) — every other action's declared conditions are
    // unchanged (AC-4.3).
    expect(byKey.get("approve")).toEqual(["entity", "self-approval"]);
    expect(byKey.get("reject")).toEqual(["entity"]);
  });

  test("GET /admin/catalog's backing read (getFullCatalog) includes refund's request resource", async () => {
    await seedRefundCatalog();

    const { getFullCatalog } = await import("./catalog");
    const fullCatalog = await getFullCatalog();

    const mine = fullCatalog.find((app) => app.appId === REFUND_APP_ID);
    expect(mine).toBeDefined();
    const requestResource = mine?.resources.find((r) => r.key === "request");
    expect(requestResource).toBeDefined();
    expect(requestResource?.actions).toHaveLength(6);
  });

  test("GET /admin/catalog's backing read (getFullCatalog) includes refund's `rate` resource (T1, specs/009-mileage-rate)", async () => {
    await seedRefundCatalog();

    const { getFullCatalog } = await import("./catalog");
    const fullCatalog = await getFullCatalog();

    const mine = fullCatalog.find((app) => app.appId === REFUND_APP_ID);
    expect(mine).toBeDefined();
    const rateResource = mine?.resources.find((r) => r.key === "rate");
    expect(rateResource).toBeDefined();
    expect(rateResource?.actions.map((a) => a.key).sort()).toEqual(["manage", "read"]);
    for (const action of rateResource?.actions ?? []) {
      expect(action.supportedConditions).toEqual([]);
    }
  });

  test("GET /admin/catalog's backing read (getFullCatalog) includes refund's `settings` resource (T1, specs/011-refund-settings, ADR-0028)", async () => {
    await seedRefundCatalog();

    const { getFullCatalog } = await import("./catalog");
    const fullCatalog = await getFullCatalog();

    const mine = fullCatalog.find((app) => app.appId === REFUND_APP_ID);
    expect(mine).toBeDefined();
    const settingsResource = mine?.resources.find((r) => r.key === "settings");
    expect(settingsResource).toBeDefined();
    expect(settingsResource?.actions.map((a) => a.key).sort()).toEqual(["manage", "read"]);
    for (const action of settingsResource?.actions ?? []) {
      expect(action.supportedConditions).toEqual([]);
    }
  });
});

describe("seedAccountingRoleGrants (T2, specs/007-refund-service — AC-5.4, AC-6.4, AC-7.5; ADR-0015)", () => {
  test("accounting gets refund:access + entity-conditioned review/set-approved-total/approve/reject; employee gets none; idempotent on re-run", async () => {
    await seedSystemRoles();
    await seedAccountingRoleGrants();
    await seedAccountingRoleGrants(); // re-run must not duplicate

    const accounting = await db.role.findUnique({ where: { name: ACCOUNTING_ROLE_NAME } });
    expect(accounting).not.toBeNull();

    const accountingRules = await db.permissionRule.findMany({
      where: { roleId: accounting!.id },
    });

    // Exactly 5 rules: refund:access (unconditional) + 4 entity-conditioned request actions.
    expect(accountingRules).toHaveLength(5);

    const access = accountingRules.find(
      (r) => r.resource === REFUND_APP_ID && r.action === "access",
    );
    expect(access).toBeDefined();
    expect(access?.conditions).toBeNull();

    for (const action of ["review", "set-approved-total", "approve", "reject"]) {
      const rule = accountingRules.find((r) => r.resource === "request" && r.action === action);
      expect(rule).toBeDefined();
      // Exact match — in particular `approve`'s conditions carry ONLY the
      // pre-existing `entity` attribute, never `self-approval` (specs/010,
      // T1, AC-3.2: the seed never retrofits the restriction onto any
      // existing role).
      expect(rule?.conditions).toEqual({ attributes: [{ key: "entity", match: "user" }] });
    }

    // No approve/reject/etc. rule carries an unconditioned (global) grant —
    // this seed ships only the entity-scoped role, never an
    // "accounting-global" role (Gate-2 decision D3; ADR-0015 point 4).
    expect(accountingRules.every((r) => r.resource !== "accounting-global")).toBe(true);

    // employee deliberately gets NOTHING refund-related — fully admin-assigned
    // (Gate-2 decision D2).
    const employee = await db.role.findUnique({ where: { name: EMPLOYEE_ROLE_NAME } });
    const employeeRefundRules = await db.permissionRule.findMany({
      where: { roleId: employee!.id, OR: [{ resource: REFUND_APP_ID }, { resource: "request" }] },
    });
    expect(employeeRefundRules).toHaveLength(0);
  });

  test("no `accounting-global` role is ever created by this seed", async () => {
    await seedSystemRoles();
    await seedAccountingRoleGrants();

    const globalRole = await db.role.findUnique({ where: { name: "accounting-global" } });
    expect(globalRole).toBeNull();
  });

  test(
    "no seeded role/rule carries `self-approval` (specs/010, T1, AC-3.2/3.3) — the catalog " +
      "gaining the option is additive-only, never retrofitted onto `accounting` or `refund-admin`",
    async () => {
      await seedSystemRoles();
      await seedAccountingRoleGrants();
      await seedRefundAdminRole();

      const accounting = await db.role.findUniqueOrThrow({ where: { name: ACCOUNTING_ROLE_NAME } });
      const refundAdmin = await db.role.findUniqueOrThrow({ where: { name: REFUND_ADMIN_ROLE_NAME } });

      const rules = await db.permissionRule.findMany({
        where: { roleId: { in: [accounting.id, refundAdmin.id] }, resource: "request", action: "approve" },
      });
      expect(rules.length).toBeGreaterThan(0);

      for (const rule of rules) {
        const conditions = rule.conditions as { attributes?: { key: string }[] } | null;
        const carriesSelfApproval = conditions?.attributes?.some((a) => a.key === "self-approval") ?? false;
        expect(carriesSelfApproval).toBe(false);
      }
    },
  );
});

// ─── Post-close follow-up: `refund-admin` role ──────────────────────────────

describe("seedRefundAdminRole (post-close follow-up, specs/007-refund-service)", () => {
  test("creates a system `refund-admin` role with refund:access + all 6 request actions, every one UNCONDITIONED, idempotent on re-run", async () => {
    await seedRefundAdminRole();
    await seedRefundAdminRole(); // re-run must not duplicate

    const role = await db.role.findUnique({ where: { name: REFUND_ADMIN_ROLE_NAME } });
    expect(role).not.toBeNull();
    expect(role!.isSystem).toBe(true);

    // Scoped to exclude `rate`/`settings` (T1, specs/009-mileage-rate + T1,
    // specs/011-refund-settings — seedRateAdminGrants/seedSettingsAdminGrants
    // ALSO grant this same shared `refund-admin` role rate:read/manage and
    // settings:read/manage; since role rows persist across this whole
    // file/run rather than being reset per test, an unscoped count here would
    // be fragile to *when* those other seed steps ran against this database,
    // not just to this function's own output).
    const rules = await db.permissionRule.findMany({
      where: { roleId: role!.id, resource: { notIn: ["rate", "settings"] } },
    });

    // Exactly 7 rules: refund:access + all 6 request actions.
    expect(rules).toHaveLength(7);

    const access = rules.find((r) => r.resource === REFUND_APP_ID && r.action === "access");
    expect(access).toBeDefined();
    expect(access?.conditions).toBeNull();

    const requestActions = ["create", "read", "review", "set-approved-total", "approve", "reject"];
    for (const action of requestActions) {
      const rule = rules.find((r) => r.resource === "request" && r.action === action);
      expect(rule).toBeDefined();
      // Every action — INCLUDING the ADR-0015 entity-scoped four — carries
      // NO conditions: an unconditioned grant resolves to GLOBAL_ENTITY_SCOPE
      // in refund-api (conditions.ts's entityScopeForPermission), which is
      // what makes this role a true cross-entity superuser rather than a
      // scoped-to-nothing one.
      expect(rule?.conditions).toBeNull();
    }

    expect(rules.map((r) => r.action).sort()).toEqual(
      ["access", "create", "read", "review", "set-approved-total", "approve", "reject"].sort(),
    );
  });

  test("is a distinct role from `accounting` — no `accounting-global` role is created either", async () => {
    await seedSystemRoles();
    await seedAccountingRoleGrants();
    await seedRefundAdminRole();

    const refundAdmin = await db.role.findUnique({ where: { name: REFUND_ADMIN_ROLE_NAME } });
    const accounting = await db.role.findUnique({ where: { name: ACCOUNTING_ROLE_NAME } });
    expect(refundAdmin).not.toBeNull();
    expect(accounting).not.toBeNull();
    expect(refundAdmin!.id).not.toBe(accounting!.id);

    const globalRole = await db.role.findUnique({ where: { name: "accounting-global" } });
    expect(globalRole).toBeNull();
  });
});

// ─── T1, specs/009-mileage-rate ─────────────────────────────────────────────

describe("seedRateAdminGrants (T1, specs/009-mileage-rate — plan.md Architecture §auth, Decision 2)", () => {
  test("grants rate:read + rate:manage to `admin` and `refund-admin`, unconditioned, idempotent on re-run", async () => {
    await seedSystemRoles();
    await seedRefundAdminRole();
    await seedRateAdminGrants();
    await seedRateAdminGrants(); // re-run must not duplicate

    for (const roleName of [ADMIN_ROLE_NAME, REFUND_ADMIN_ROLE_NAME]) {
      const role = await db.role.findUnique({ where: { name: roleName } });
      expect(role).not.toBeNull();

      const rateRules = await db.permissionRule.findMany({
        where: { roleId: role!.id, resource: "rate" },
      });
      expect(rateRules).toHaveLength(2);
      expect(rateRules.map((r) => r.action).sort()).toEqual(["manage", "read"]);
      for (const rule of rateRules) {
        expect(rule.conditions).toBeNull();
      }
    }
  });

  test("does NOT grant `rate` to `employee` or `accounting`", async () => {
    await seedSystemRoles();
    await seedAccountingRoleGrants();
    await seedRateAdminGrants();

    for (const roleName of [EMPLOYEE_ROLE_NAME, ACCOUNTING_ROLE_NAME]) {
      const role = await db.role.findUnique({ where: { name: roleName } });
      const rateRules = await db.permissionRule.findMany({
        where: { roleId: role!.id, resource: "rate" },
      });
      expect(rateRules).toHaveLength(0);
    }
  });
});

// ─── T1, specs/011-refund-settings ──────────────────────────────────────────

describe("seedSettingsAdminGrants (T1, specs/011-refund-settings — plan.md Architecture §auth, Decision D2; ADR-0028)", () => {
  test("grants settings:read + settings:manage to `admin` and `refund-admin`, unconditioned, idempotent on re-run", async () => {
    await seedSystemRoles();
    await seedRefundAdminRole();
    await seedSettingsAdminGrants();
    await seedSettingsAdminGrants(); // re-run must not duplicate

    for (const roleName of [ADMIN_ROLE_NAME, REFUND_ADMIN_ROLE_NAME]) {
      const role = await db.role.findUnique({ where: { name: roleName } });
      expect(role).not.toBeNull();

      const settingsRules = await db.permissionRule.findMany({
        where: { roleId: role!.id, resource: "settings" },
      });
      expect(settingsRules).toHaveLength(2);
      expect(settingsRules.map((r) => r.action).sort()).toEqual(["manage", "read"]);
      for (const rule of settingsRules) {
        expect(rule.conditions).toBeNull();
      }
    }
  });

  test("does NOT grant `settings` to `employee` or `accounting`", async () => {
    await seedSystemRoles();
    await seedAccountingRoleGrants();
    await seedSettingsAdminGrants();

    for (const roleName of [EMPLOYEE_ROLE_NAME, ACCOUNTING_ROLE_NAME]) {
      const role = await db.role.findUnique({ where: { name: roleName } });
      const settingsRules = await db.permissionRule.findMany({
        where: { roleId: role!.id, resource: "settings" },
      });
      expect(settingsRules).toHaveLength(0);
    }
  });

  test("`settings` grants are separate from `rate` grants — NOT a reuse of rate:manage (ADR-0028)", async () => {
    await seedSystemRoles();
    await seedRefundAdminRole();
    await seedRateAdminGrants();
    await seedSettingsAdminGrants();

    const admin = await db.role.findUniqueOrThrow({ where: { name: ADMIN_ROLE_NAME } });
    const rateRules = await db.permissionRule.findMany({
      where: { roleId: admin.id, resource: "rate" },
    });
    const settingsRules = await db.permissionRule.findMany({
      where: { roleId: admin.id, resource: "settings" },
    });
    // Both present, but as distinct rows under distinct resource keys —
    // revoking one (e.g. deleting the `rate` rows) must not implicate the
    // other.
    expect(rateRules).toHaveLength(2);
    expect(settingsRules).toHaveLength(2);
    const rateRuleIds = new Set(rateRules.map((r) => r.id));
    for (const rule of settingsRules) {
      expect(rateRuleIds.has(rule.id)).toBe(false);
    }
  });
});

// ─── Baseline role assignment (AC-6.1, AC-6.3) ──────────────────────────────

describe("assignBaselineRolesToNewUser (T11, AC-6.1/6.3)", () => {
  const createdUserIds: string[] = [];

  async function createUser(label: string, emailVerified = true) {
    const user = await db.user.create({
      data: {
        email: `t11-${label}-${RUN_ID}@operai.test`,
        name: `T11 fixture ${label}`,
        emailVerified,
      },
    });
    createdUserIds.push(user.id);
    return user;
  }

  afterEach(() => setBootstrapEmail(undefined));

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
  });

  test("a newly-created user gets the baseline `employee` role and nothing more (AC-6.3)", async () => {
    const user = await createUser("employee-only");

    await assignBaselineRolesToNewUser(user);

    expect(await userHasRole(user.id, EMPLOYEE_ROLE_NAME)).toBe(true);
    expect(await userHasRole(user.id, ADMIN_ROLE_NAME)).toBe(false);
  });

  test("a user whose email matches BOOTSTRAP_ADMIN_EMAIL gets `employee` AND `admin` (AC-6.1)", async () => {
    const user = await createUser("bootstrap-match");
    setBootstrapEmail(user.email);

    await assignBaselineRolesToNewUser(user);

    expect(await userHasRole(user.id, EMPLOYEE_ROLE_NAME)).toBe(true);
    expect(await userHasRole(user.id, ADMIN_ROLE_NAME)).toBe(true);
  });

  test("the bootstrap email match is case-insensitive", async () => {
    const user = await createUser("bootstrap-case");
    setBootstrapEmail(user.email.toUpperCase());

    await assignBaselineRolesToNewUser(user);

    expect(await userHasRole(user.id, ADMIN_ROLE_NAME)).toBe(true);
  });

  test("a non-bootstrap user does NOT get admin even when BOOTSTRAP_ADMIN_EMAIL is configured for someone else", async () => {
    setBootstrapEmail(`t11-someone-else-${RUN_ID}@operai.test`);
    const user = await createUser("not-bootstrap");

    await assignBaselineRolesToNewUser(user);

    expect(await userHasRole(user.id, EMPLOYEE_ROLE_NAME)).toBe(true);
    expect(await userHasRole(user.id, ADMIN_ROLE_NAME)).toBe(false);
  });

  test("does NOT grant admin when the matching email is not (yet) verified", async () => {
    const user = await createUser("unverified", false);
    setBootstrapEmail(user.email);

    await assignBaselineRolesToNewUser(user);

    expect(await userHasRole(user.id, EMPLOYEE_ROLE_NAME)).toBe(true);
    expect(await userHasRole(user.id, ADMIN_ROLE_NAME)).toBe(false);
  });

  test(
    "does NOT grant admin when emailVerified is undefined/unset (owasp/QE fix — " +
      "the bootstrap check must require emailVerified === true explicitly; " +
      "treating an absent value as verified would let an unverified-email " +
      "signup path self-claim the bootstrap identity)",
    async () => {
      const email = `t11-emailverified-unset-${RUN_ID}@operai.test`;
      const user = await db.user.create({
        data: { email, name: "T11 fixture emailVerified-unset", emailVerified: true },
      });
      createdUserIds.push(user.id);
      setBootstrapEmail(email);

      // Simulate a caller whose `NewUserForBootstrap.emailVerified` field is
      // entirely absent (not merely `false`) — e.g. a hypothetical provider
      // that doesn't report the field at all. The field is optional on the
      // interface, so this object is a valid `NewUserForBootstrap` without it.
      const userWithoutEmailVerified: { id: string; email: string } = {
        id: user.id,
        email: user.email,
      };

      await assignBaselineRolesToNewUser(userWithoutEmailVerified);

      expect(await userHasRole(user.id, EMPLOYEE_ROLE_NAME)).toBe(true);
      expect(await userHasRole(user.id, ADMIN_ROLE_NAME)).toBe(false);
    },
  );

  test("is idempotent — calling it twice for the same user does not error or duplicate role rows", async () => {
    const user = await createUser("idempotent");
    setBootstrapEmail(user.email);

    await assignBaselineRolesToNewUser(user);
    await assignBaselineRolesToNewUser(user);

    const rows = await db.userRole.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(2); // employee + admin, no duplicates
  });

  test("seedSystemRoles need not have run first — the hook upserts roles defensively", async () => {
    // Sanity: the roles exist from earlier tests/seed() calls in this run, so
    // this asserts the upsert path itself (update branch), not the create
    // branch specifically — both are exercised across this whole file.
    const user = await createUser("defensive-upsert");

    await assignBaselineRolesToNewUser(user);

    expect(await userHasRole(user.id, EMPLOYEE_ROLE_NAME)).toBe(true);
  });
});

describe("seed() — runs every deploy-time step", () => {
  test("completes without error and leaves roles + catalogs (incl. EstimAI's T26, refund's T2) in place", async () => {
    await seed();

    const roles = await db.role.findMany({
      where: { name: { in: [...SYSTEM_ROLE_NAMES] } },
    });
    expect(roles).toHaveLength(4);

    const adminCatalog = await getAppCatalog("admin");
    expect(adminCatalog.resources.some((r) => r.key === "admin")).toBe(true);

    const estimaiCatalog = await getAppCatalog(ESTIMAI_APP_ID);
    expect(estimaiCatalog.resources.some((r) => r.key === ESTIMAI_APP_ID)).toBe(true);
    const estimateResource = estimaiCatalog.resources.find((r) => r.key === "estimate");
    expect(estimateResource?.actions).toHaveLength(4);

    const refundCatalog = await getAppCatalog(REFUND_APP_ID);
    expect(refundCatalog.resources.some((r) => r.key === REFUND_APP_ID)).toBe(true);
    const requestResource = refundCatalog.resources.find((r) => r.key === "request");
    expect(requestResource?.actions).toHaveLength(6);

    // seed() also attaches the accounting role's refund grants (T2).
    const accounting = await db.role.findUnique({ where: { name: ACCOUNTING_ROLE_NAME } });
    const accountingRefundRules = await db.permissionRule.findMany({
      where: { roleId: accounting!.id, resource: "request" },
    });
    expect(accountingRefundRules.length).toBeGreaterThanOrEqual(4);

    // seed() also seeds the refund-admin role (post-close follow-up), now
    // extended by T1 (specs/009-mileage-rate) with the `rate` resource's two
    // unconditioned actions on top of its original 7 (refund:access + 6
    // request actions) — 9 total — and further extended by T1
    // (specs/011-refund-settings, ADR-0028) with the `settings` resource's
    // two unconditioned actions — 11 total.
    const refundAdmin = await db.role.findUnique({ where: { name: REFUND_ADMIN_ROLE_NAME } });
    expect(refundAdmin).not.toBeNull();
    const refundAdminRules = await db.permissionRule.findMany({
      where: { roleId: refundAdmin!.id },
    });
    expect(refundAdminRules.length).toBe(11);

    // seed() also grants rate:read + rate:manage to `admin` (T1, specs/009-mileage-rate).
    const admin = await db.role.findUnique({ where: { name: ADMIN_ROLE_NAME } });
    const adminRateRules = await db.permissionRule.findMany({
      where: { roleId: admin!.id, resource: "rate" },
    });
    expect(adminRateRules.map((r) => r.action).sort()).toEqual(["manage", "read"]);

    // seed() also grants settings:read + settings:manage to `admin` (T1, specs/011-refund-settings).
    const adminSettingsRules = await db.permissionRule.findMany({
      where: { roleId: admin!.id, resource: "settings" },
    });
    expect(adminSettingsRules.map((r) => r.action).sort()).toEqual(["manage", "read"]);
  });
});

describe("seedAdminRoleGrants — admin can reach the whole suite (bootstrap usability)", () => {
  test("grants the admin role `access` to every app; employee gets none; idempotent", async () => {
    await seedSystemRoles();
    await seedAdminRoleGrants();
    await seedAdminRoleGrants(); // re-run must not duplicate

    const admin = await db.role.findUnique({ where: { name: ADMIN_ROLE_NAME } });
    const adminAccess = await db.permissionRule.findMany({
      where: { roleId: admin!.id, action: "access" },
    });
    expect(adminAccess.map((r) => r.resource).sort()).toEqual([...ALL_APP_IDS].sort());
    expect(adminAccess.length).toBe(ALL_APP_IDS.length); // idempotent — no dups

    // Employees deliberately get nothing (fully admin-assigned, specs/004).
    const employee = await db.role.findUnique({ where: { name: EMPLOYEE_ROLE_NAME } });
    const employeeRules = await db.permissionRule.findMany({ where: { roleId: employee!.id } });
    expect(employeeRules).toHaveLength(0);
  });
});

describe("ensureBootstrapAdmin — promotes an already-existing account", () => {
  const ids: string[] = [];
  afterAll(async () => {
    if (ids.length) await db.user.deleteMany({ where: { id: { in: ids } } });
    setBootstrapEmail(undefined);
  });

  test("an EXISTING user whose email matches BOOTSTRAP_ADMIN_EMAIL gets admin + an epoch bump (no create hook needed)", async () => {
    const email = `ensure-bootstrap-${RUN_ID}@operai.test`;
    // A user who signed in BEFORE the env var was set: exists, employee-only, no admin.
    const user = await db.user.create({ data: { email, name: "Pre-existing", emailVerified: true } });
    ids.push(user.id);
    await seedSystemRoles();
    expect(await userHasRole(user.id, ADMIN_ROLE_NAME)).toBe(false);

    setBootstrapEmail(email.toUpperCase()); // case-insensitive match
    await ensureBootstrapAdmin();

    expect(await userHasRole(user.id, ADMIN_ROLE_NAME)).toBe(true);
    const after = await db.user.findUnique({ where: { id: user.id }, select: { permissionEpoch: true } });
    expect(after!.permissionEpoch).toBeGreaterThan(0);
  });

  test("no-op when BOOTSTRAP_ADMIN_EMAIL is unset", async () => {
    setBootstrapEmail(undefined);
    await ensureBootstrapAdmin(); // must not throw
    expect(true).toBe(true);
  });
});
