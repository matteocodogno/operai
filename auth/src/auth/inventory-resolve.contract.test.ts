/**
 * Contract test: what `GET /authz/resolve` returns for the seeded inventory
 * roles (T3, specs/015-hardware-inventory — refs AC-9.3, AC-9.4, AC-9.5,
 * AC-9.6; ADR-0015, ADR-0014).
 *
 * `inventory-api` evaluates the entity condition locally from exactly this
 * response (`permissions[].conditions.attributes` + the caller's `entity`), so
 * the seed and the resolver have to agree on that shape end to end — a
 * catalog/seed unit test alone would not catch a divergence in what the route
 * actually serves.
 *
 * WHY THIS FILE LIVES IN `src/auth/` (not next to `seed.test.ts`): the real
 * token-mint flow needs `auth.config`, and resolving it from `src/authz/` or
 * `src/admin/` collides with sibling test files that `mock.module` it for the
 * whole process — see `authz-resolve.routes.test.ts`'s doc comment for the
 * confirmed hazard. Same strategy as that file: real session -> real RS256
 * token -> Bearer call, no mocks.
 *
 * DB-ISOLATION: every fixture email is unique per run; the users (and their
 * cascaded role assignments) are deleted in `afterAll`. The seeded roles are
 * shared and only read here, never modified.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "../lib/db";

process.env["ENABLE_TEST_AUTH"] = "true";
if (process.env["NODE_ENV"] === "production") {
  process.env["NODE_ENV"] = "test";
}

const { env } = await import("../lib/env");
(env as unknown as Record<string, unknown>)["ENABLE_TEST_AUTH"] = true;
if (env.NODE_ENV === "production") {
  (env as unknown as Record<string, unknown>)["NODE_ENV"] = "test";
}

const { testAuthRouter } = await import("../test-auth/test-auth.routes");
const { authRouter } = await import("./auth.routes");
const { resolveRouter } = await import("../authz/resolve.routes");
const { seedSystemRoles, seedInventoryCatalog, seedInventoryGrants, ACCOUNTING_ROLE_NAME, INVENTORY_MANAGER_ROLE_NAME } =
  await import("../authz/seed");
const { ADMIN_ROLE_NAME } = await import("../admin/lastAdminGuard");

const RUN_ID = crypto.randomUUID().slice(0, 8);
const createdUserIds = new Set<string>();

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: Array.from(createdUserIds) } } });
});

beforeAll(async () => {
  await seedSystemRoles();
  await seedInventoryCatalog();
  await seedInventoryGrants();
});

type Resolved = {
  entity: string | null;
  permissions: {
    resource: string;
    action: string;
    conditions: { attributes?: { key: string; match: string }[] } | null;
  }[];
};

/** A fresh user holding exactly `roleName`, resolved through the real Bearer route. */
async function resolveAs(roleName: string, entity: string): Promise<Resolved> {
  const email = `t3-inv-${roleName}-${RUN_ID}-${crypto.randomUUID()}@operai.test`;
  const sessionRes = await testAuthRouter.request("/test-auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, name: `T3 ${roleName}` }),
  });
  expect(sessionRes.status).toBe(200);
  const { userId } = (await sessionRes.json()) as { userId: string };
  createdUserIds.add(userId);

  await db.user.update({ where: { id: userId }, data: { entity } });
  // A new user gets the baseline `employee` role from the create hook; add the one under test.
  const role = await db.role.findUniqueOrThrow({ where: { name: roleName } });
  await db.userRole.upsert({
    where: { userId_roleId: { userId, roleId: role.id } },
    update: {},
    create: { userId, roleId: role.id },
  });

  const cookiePair = ((sessionRes.headers.get("set-cookie") as string).split(";")[0]) ?? "";
  const tokenRes = await authRouter.request("/auth/token", { headers: { Cookie: cookiePair } });
  expect(tokenRes.status).toBe(200);
  const { token } = (await tokenRes.json()) as { token: string };

  const res = await resolveRouter.request("/authz/resolve", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Resolved;
}

const pairs = (r: Resolved) => r.permissions.map((p) => `${p.resource}:${p.action}`).sort();
const find = (r: Resolved, resource: string, action: string) =>
  r.permissions.find((p) => p.resource === resource && p.action === action);

describe("GET /authz/resolve for the seeded inventory roles (T3)", () => {
  test("an `accounting` user resolves ledger:manage with the entity attribute, plus their own entity (AC-9.4)", async () => {
    const resolved = await resolveAs(ACCOUNTING_ROLE_NAME, "welld_ch");

    expect(resolved.entity).toBe("welld_ch");
    expect(find(resolved, "ledger", "manage")?.conditions).toEqual({
      attributes: [{ key: "entity", match: "user" }],
    });
    expect(find(resolved, "inventory", "access")?.conditions).toBeNull();
    // Accounting does not manage assets (AC-9.5).
    expect(find(resolved, "asset", "manage")).toBeUndefined();
  });

  test("an `inventory-manager` user resolves asset:manage with the entity attribute and no ledger grant (AC-9.3/9.5)", async () => {
    const resolved = await resolveAs(INVENTORY_MANAGER_ROLE_NAME, "welld_it");

    expect(resolved.entity).toBe("welld_it");
    expect(find(resolved, "asset", "manage")?.conditions).toEqual({
      attributes: [{ key: "entity", match: "user" }],
    });
    expect(find(resolved, "inventory", "access")?.conditions).toBeNull();
    expect(find(resolved, "ledger", "manage")).toBeUndefined();
  });

  test("an `admin` user resolves all three inventory permissions unconditioned (both entities)", async () => {
    const resolved = await resolveAs(ADMIN_ROLE_NAME, "welld_ch");

    for (const [resource, action] of [
      ["inventory", "access"],
      ["asset", "manage"],
      ["ledger", "manage"],
    ] as const) {
      expect(find(resolved, resource, action)?.conditions).toBeNull();
    }
  });

  test("a plain employee resolves none of the inventory permissions (AC-9.6 — the tool stays hidden)", async () => {
    const resolved = await resolveAs("employee", "welld_ch");
    expect(pairs(resolved).filter((p) => /^(inventory|asset|ledger):/.test(p))).toEqual([]);
  });
});
