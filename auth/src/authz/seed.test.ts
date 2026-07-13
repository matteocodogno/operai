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
import {
  assignBaselineRolesToNewUser,
  EMPLOYEE_ROLE_NAME,
  seed,
  seedAppAccessCatalog,
  seedEstimaiCatalog,
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
  test("registers a single access-only resource for refund and admin, idempotent on re-run", async () => {
    await seedAppAccessCatalog();
    await seedAppAccessCatalog(); // re-run — full-replace upsert, must not duplicate

    for (const appId of ["refund", "admin"]) {
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
  test("completes without error and leaves roles + catalogs (incl. EstimAI's, T26) in place", async () => {
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
  });
});
