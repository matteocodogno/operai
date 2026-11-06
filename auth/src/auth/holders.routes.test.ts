/**
 * Integration tests for GET /authz/users/holders (T20, specs/022-projects-handoff
 * - refs AC-4.1, AC-4.2; security-review.md M4, L4).
 *
 * WHY THIS FILE LIVES IN `src/auth/` and not next to the route in `src/authz/`
 * (the task's listed path): the real Bearer-token mint flow needs the real
 * `auth.config`, which sibling test files in `src/admin/`, `src/authz/` and
 * `src/test-auth/` `mock.module` for the rest of the process. Whether a test
 * file sees the real one then depends on the order the runner visits the
 * directories: here, in the full run, every file of `src/auth/` runs before any
 * of them (see `directory.routes.test.ts`, `identities.routes.test.ts`,
 * `appAccessCheck.routes.test.ts`, `authz-resolve.routes.test.ts`). Left in
 * `src/authz/` this file passed alone and failed all 36 tests in the full
 * `bun test` (the mint returned a user id that was never written).
 *
 * DB-ISOLATION: the user table is shared and holds other tests' fixtures and the
 * real admins, so assertions look only at THIS run's fixture ids (and relative
 * order among them). Every user, role and department created here is deleted in
 * `afterAll`. The seeded system roles (`ops-manager`, `admin`, `sales`) are only
 * ASSIGNED, never edited: the grants under test are T19's own.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";

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
const { holdersRouter, HOLDERS_RATE_LIMIT } = await import("../authz/holders.routes");
const { directoryRouter } = await import("../authz/directory.routes");
const { seedAdminRoleGrants, seedProjectsGrants, seedSystemRoles, OPS_MANAGER_ROLE_NAME, SALES_ROLE_NAME } =
  await import("../authz/seed");
const { ADMIN_ROLE_NAME } = await import("../admin/lastAdminGuard");

const RUN_ID = crypto.randomUUID().slice(0, 8);
const createdUserIds = new Set<string>();
const createdRoleIds = new Set<string>();
const createdDepartmentIds = new Set<string>();

const roleIds = new Map<string, string>();
const roleIdOf = (name: string): string => {
  const id = roleIds.get(name);
  if (id === undefined) throw new Error(`unknown system role ${name}`);
  return id;
};

beforeAll(async () => {
  // Idempotent, non-destructive: makes a fresh database carry T19's grants too.
  await seedSystemRoles();
  await seedProjectsGrants();
  await seedAdminRoleGrants();
  for (const name of [OPS_MANAGER_ROLE_NAME, ADMIN_ROLE_NAME, SALES_ROLE_NAME]) {
    const role = await db.role.findUniqueOrThrow({ where: { name } });
    roleIds.set(name, role.id);
  }
});

afterAll(async () => {
  await db.department.deleteMany({ where: { id: { in: Array.from(createdDepartmentIds) } } });
  await db.role.deleteMany({ where: { id: { in: Array.from(createdRoleIds) } } });
  // Cascades the user_role rows of the seeded roles assigned below.
  await db.user.deleteMany({ where: { id: { in: Array.from(createdUserIds) } } });
});

type Fixture = { userId: string; name: string; token: string };
type Grant = { resource: string; action: string; conditions?: object };

async function mintUser(
  label: string,
  opts: { name?: string; entity?: string; systemRoles?: string[]; grants?: Grant[] } = {},
): Promise<Fixture> {
  const email = `t20-${label}-${RUN_ID}-${crypto.randomUUID()}@operai.test`;
  const name = opts.name ?? `T20 ${label} ${RUN_ID}`;

  const sessionRes = await testAuthRouter.request("/test-auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, name }),
  });
  expect(sessionRes.status).toBe(200);
  const { userId } = (await sessionRes.json()) as { userId: string };
  createdUserIds.add(userId);

  if (opts.entity !== undefined) {
    await db.user.update({ where: { id: userId }, data: { entity: opts.entity } });
  }

  // The user-create hook may already have assigned baseline roles; only add ours.
  for (const roleName of opts.systemRoles ?? []) {
    const roleId = roleIdOf(roleName);
    await db.userRole.upsert({
      where: { userId_roleId: { userId, roleId } },
      update: {},
      create: { userId, roleId },
    });
  }

  if (opts.grants?.length) {
    const role = await db.role.create({ data: { name: `t20-role-${label}-${RUN_ID}-${crypto.randomUUID()}` } });
    createdRoleIds.add(role.id);
    for (const g of opts.grants) {
      await db.permissionRule.create({
        data: {
          roleId: role.id,
          resource: g.resource,
          action: g.action,
          ...(g.conditions ? { conditions: g.conditions as Prisma.InputJsonValue } : {}),
        },
      });
    }
    await db.userRole.create({ data: { userId, roleId: role.id } });
  }

  const cookiePair = ((sessionRes.headers.get("set-cookie") as string).split(";")[0]) ?? "";
  const tokenRes = await authRouter.request("/auth/token", { headers: { Cookie: cookiePair } });
  expect(tokenRes.status).toBe(200);
  const { token } = (await tokenRes.json()) as { token: string };
  return { userId, name, token };
}

const ENTITY_CONDITION = { attributes: [{ key: "entity", match: "user" }] };
const TAKE = { resource: "handoff", action: "take", conditions: ENTITY_CONDITION };
const QUERY = "resource=purchase-order&action=receive&entity=welld_ch";

const callHolders = (token: string | undefined, qs: string = QUERY) =>
  holdersRouter.request(`/authz/users/holders?${qs}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

type HoldersBody = { users: { id: string; name: string; unconditioned: boolean }[] };

/** A caller allowed to ask: a sales user holds handoff:take (own entity). */
const mintCaller = (label: string) => mintUser(label, { entity: "welld_ch", systemRoles: [SALES_ROLE_NAME] });

describe("GET /authz/users/holders (T20, specs/022; AC-4.1, AC-4.2)", () => {
  test("lists the active ops-managers of the asked entity (unconditioned: false) and the admins (true), as { id, name, unconditioned } only", async () => {
    const caller = await mintCaller("list-caller");
    const opsCh = await mintUser("ops-ch", { entity: "welld_ch", systemRoles: [OPS_MANAGER_ROLE_NAME] });
    const admin = await mintUser("admin", { systemRoles: [ADMIN_ROLE_NAME] });

    const res = await callHolders(caller.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HoldersBody;

    expect(Object.keys(body)).toEqual(["users"]);
    const byId = new Map(body.users.map((u) => [u.id, u]));
    expect(byId.get(opsCh.userId)).toEqual({ id: opsCh.userId, name: opsCh.name, unconditioned: false });
    expect(byId.get(admin.userId)).toEqual({ id: admin.userId, name: admin.name, unconditioned: true });
    for (const user of body.users) {
      expect(Object.keys(user).sort()).toEqual(["id", "name", "unconditioned"]);
    }
  });

  test("asks for the other entity: that entity's ops-managers, never the first one's; admins in both", async () => {
    const caller = await mintCaller("entity-caller");
    const opsCh = await mintUser("e-ops-ch", { entity: "welld_ch", systemRoles: [OPS_MANAGER_ROLE_NAME] });
    const opsIt = await mintUser("e-ops-it", { entity: "welld_it", systemRoles: [OPS_MANAGER_ROLE_NAME] });
    const admin = await mintUser("e-admin", { systemRoles: [ADMIN_ROLE_NAME] });

    const ch = ((await (await callHolders(caller.token, QUERY)).json()) as HoldersBody).users.map((u) => u.id);
    expect(ch).toContain(opsCh.userId);
    expect(ch).not.toContain(opsIt.userId);
    expect(ch).toContain(admin.userId);

    const itQuery = "resource=purchase-order&action=receive&entity=welld_it";
    const it = ((await (await callHolders(caller.token, itQuery)).json()) as HoldersBody).users.map((u) => u.id);
    expect(it).toContain(opsIt.userId);
    expect(it).not.toContain(opsCh.userId);
    expect(it).toContain(admin.userId);
  });

  test("is absent: a soft-deleted holder, one without projects:access, and an ops-manager with no entity", async () => {
    const caller = await mintCaller("excl-caller");
    const gone = await mintUser("x-gone", { entity: "welld_ch", systemRoles: [OPS_MANAGER_ROLE_NAME] });
    await db.user.update({ where: { id: gone.userId }, data: { deletedAt: new Date() } });
    const noAccess = await mintUser("x-no-access", {
      entity: "welld_ch",
      grants: [{ resource: "purchase-order", action: "receive", conditions: ENTITY_CONDITION }],
    });
    const noAccessUnconditioned = await mintUser("x-no-access-all", {
      grants: [{ resource: "purchase-order", action: "receive" }],
    });
    const noEntity = await mintUser("x-no-entity", { systemRoles: [OPS_MANAGER_ROLE_NAME] });
    const control = await mintUser("x-control", { entity: "welld_ch", systemRoles: [OPS_MANAGER_ROLE_NAME] });

    const ids = ((await (await callHolders(caller.token)).json()) as HoldersBody).users.map((u) => u.id);
    expect(ids).toContain(control.userId);
    for (const absent of [gone, noAccess, noAccessUnconditioned, noEntity]) {
      expect(ids).not.toContain(absent.userId);
    }
  });

  test("fails closed on a condition it does not recognise: ownership, another attribute, another match, extras", async () => {
    const caller = await mintCaller("closed-caller");
    const withConditions = (label: string, conditions: object) =>
      mintUser(label, {
        entity: "welld_ch",
        grants: [
          { resource: "projects", action: "access" },
          { resource: "purchase-order", action: "receive", conditions },
        ],
      });
    const ownership = await withConditions("c-ownership", { ownership: "own" });
    const ownershipAny = await withConditions("c-ownership-any", { ownership: "any" });
    const otherKey = await withConditions("c-other-key", { attributes: [{ key: "department", match: "user" }] });
    const otherMatch = await withConditions("c-other-match", { attributes: [{ key: "entity", match: "welld_ch" }] });
    const entityPlusExtra = await withConditions("c-extra", {
      attributes: [
        { key: "entity", match: "user" },
        { key: "department", match: "user" },
      ],
    });
    const control = await withConditions("c-control", ENTITY_CONDITION);

    const ids = ((await (await callHolders(caller.token)).json()) as HoldersBody).users.map((u) => u.id);
    expect(ids).toContain(control.userId);
    for (const absent of [ownership, ownershipAny, otherKey, otherMatch, entityPlusExtra]) {
      expect(ids).not.toContain(absent.userId);
    }
  });

  test("is sorted by name (case- and accent-insensitive), regardless of creation order", async () => {
    const caller = await mintCaller("sort-caller");
    const grants = [
      { resource: "projects", action: "access" },
      { resource: "purchase-order", action: "receive" },
    ];
    const zed = await mintUser("s-z", { name: `${RUN_ID} Zeta`, grants });
    const alpha = await mintUser("s-a", { name: `${RUN_ID} alpha`, grants });
    const eacute = await mintUser("s-e", { name: `${RUN_ID} Élodie`, grants });
    const bravo = await mintUser("s-b", { name: `${RUN_ID} Bravo`, grants });

    const body = (await (await callHolders(caller.token)).json()) as HoldersBody;
    const mine = new Set([zed.userId, alpha.userId, eacute.userId, bravo.userId]);
    expect(body.users.filter((u) => mine.has(u.id)).map((u) => u.name)).toEqual([
      `${RUN_ID} alpha`,
      `${RUN_ID} Bravo`,
      `${RUN_ID} Élodie`,
      `${RUN_ID} Zeta`,
    ]);
  });

  test("the response is not cacheable (it is a roster of people)", async () => {
    const caller = await mintCaller("nocache-caller");
    const res = await callHolders(caller.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test.each([
    ["asset:manage", "resource=asset&action=manage&entity=welld_ch"],
    ["purchase-order:bexio", "resource=purchase-order&action=bexio&entity=welld_ch"],
    ["handoff:take", "resource=handoff&action=take&entity=welld_ch"],
    ["projects:access", "resource=projects&action=access&entity=welld_ch"],
    ["right resource, wrong action", "resource=purchase-order&action=manage&entity=welld_ch"],
    ["wrong resource, right action", "resource=project&action=receive&entity=welld_ch"],
  ])("answers only purchase-order:receive: %s -> 400 unsupported_permission", async (_label, qs) => {
    const caller = await mintCaller("pair-caller");
    const res = await callHolders(caller.token, qs);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("unsupported_permission");
    expect(body["status"]).toBe(400);
    expect(body["users"]).toBeUndefined();
  });

  test.each([
    ["an unknown parameter", `${QUERY}&email=x`],
    ["the directory's appId", `${QUERY}&appId=projects`],
    ["an unknown entity", "resource=purchase-order&action=receive&entity=welld_xx"],
    ["a differently cased entity", "resource=purchase-order&action=receive&entity=WELLD_CH"],
    ["no entity", "resource=purchase-order&action=receive"],
    ["no resource", "action=receive&entity=welld_ch"],
    ["no action", "resource=purchase-order&entity=welld_ch"],
    ["no query at all", ""],
    ["a repeated entity", `${QUERY}&entity=welld_it`],
    ["a repeated resource", `${QUERY}&resource=asset`],
  ])("a malformed query is 400: %s", async (_label, qs) => {
    const caller = await mintCaller("query-caller");
    const res = await callHolders(caller.token, qs);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["status"]).toBe(400);
    expect(body["users"]).toBeUndefined();
  });

  test("401 without a Bearer token, and with a garbage one", async () => {
    expect((await callHolders(undefined)).status).toBe(401);
    expect((await callHolders("not-a-jwt")).status).toBe(401);
  });

  test.each([
    ["asset:manage (the inventory manager)", [{ resource: "asset", action: "manage", conditions: ENTITY_CONDITION }]],
    ["deal:manage (the deal manager)", [{ resource: "deal", action: "manage", conditions: ENTITY_CONDITION }]],
    ["project:manage", [{ resource: "project", action: "manage", conditions: ENTITY_CONDITION }]],
    ["purchase-order:receive itself", [{ resource: "purchase-order", action: "receive", conditions: ENTITY_CONDITION }]],
    [
      "projects:access and purchase-order:bexio",
      [
        { resource: "projects", action: "access" },
        { resource: "purchase-order", action: "bexio" },
      ],
    ],
    ["handoff with another action", [{ resource: "handoff", action: "give", conditions: ENTITY_CONDITION }]],
    ["no grants at all", []],
  ])("a caller holding %s, not handoff:take, gets 403 and no roster", async (_label, grants) => {
    const caller = await mintUser("gate-denied", { entity: "welld_ch", grants });
    const res = await callHolders(caller.token);
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["status"]).toBe(403);
    expect(body["code"]).toBe("holders_forbidden");
    expect(body["users"]).toBeUndefined();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("handoff:take opens it under any entity: own-entity (sales), no entity at all, and unconditioned (admin)", async () => {
    const sales = await mintUser("gate-sales", { entity: "welld_it", systemRoles: [SALES_ROLE_NAME] });
    const noEntity = await mintUser("gate-no-entity", { grants: [TAKE] });
    const admin = await mintUser("gate-admin", { systemRoles: [ADMIN_ROLE_NAME] });
    for (const caller of [sales, noEntity, admin]) {
      expect((await callHolders(caller.token)).status).toBe(200);
    }
  });

  test("the gate answers before the query is read: a non-holder asking for asset:manage learns 403, not 400", async () => {
    const outsider = await mintUser("gate-order", { grants: [{ resource: "asset", action: "manage" }] });
    const res = await callHolders(outsider.token, "resource=asset&action=manage&entity=nope");
    expect(res.status).toBe(403);
  });

  test("a soft-deleted caller with a still-valid token gets 403 (ADR-0012 residual JWT)", async () => {
    const caller = await mintCaller("gate-deleted");
    expect((await callHolders(caller.token)).status).toBe(200);
    await db.user.update({ where: { id: caller.userId }, data: { deletedAt: new Date() } });
    expect((await callHolders(caller.token)).status).toBe(403);
  });

  test("revoking handoff:take takes effect immediately (live resolution)", async () => {
    const caller = await mintCaller("gate-revoked");
    expect((await callHolders(caller.token)).status).toBe(200);
    await db.userRole.deleteMany({ where: { userId: caller.userId, roleId: roleIdOf(SALES_ROLE_NAME) } });
    expect((await callHolders(caller.token)).status).toBe(403);
  });

  test("its own limiter counts every attempt, 403s included: the (limit+1)th is 429 + Retry-After; others and the directory's limiter are unaffected", async () => {
    // Not a holder of handoff:take, but a holder of asset:manage: the directory would answer it.
    const heavy = await mintUser("rl-heavy", { grants: [{ resource: "asset", action: "manage" }] });
    const other = await mintCaller("rl-other");

    for (let i = 0; i < HOLDERS_RATE_LIMIT; i++) {
      expect((await callHolders(heavy.token)).status).toBe(403);
    }
    const over = await callHolders(heavy.token);
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(over.headers.get("Cache-Control")).toBe("no-store");
    const body = (await over.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("rate_limited");
    expect(body["users"]).toBeUndefined();

    expect((await callHolders(other.token)).status).toBe(200);
    const directory = await directoryRouter.request("/authz/users/directory", {
      headers: { Authorization: `Bearer ${heavy.token}` },
    });
    expect(directory.status).toBe(200);
  }, 60000);

  test("a malformed query counts too: a holder sending limit bad queries is then 429 on a good one", async () => {
    const caller = await mintCaller("rl-bad-queries");
    for (let i = 0; i < HOLDERS_RATE_LIMIT; i++) {
      expect((await callHolders(caller.token, "entity=nope")).status).toBe(400);
    }
    expect((await callHolders(caller.token)).status).toBe(429);
  }, 60000);

  test("a grant conferred by a department counts like a direct one", async () => {
    const caller = await mintCaller("dept-caller");
    const member = await mintUser("dept-member", { entity: "welld_ch" });
    const bystander = await mintUser("dept-bystander", { entity: "welld_ch" });

    const role = await db.role.create({ data: { name: `t20-role-dept-${RUN_ID}-${crypto.randomUUID()}` } });
    createdRoleIds.add(role.id);
    for (const [resource, action, conditions] of [
      ["projects", "access", undefined],
      ["purchase-order", "receive", ENTITY_CONDITION],
    ] as const) {
      await db.permissionRule.create({
        data: {
          roleId: role.id,
          resource,
          action,
          ...(conditions ? { conditions: conditions as Prisma.InputJsonValue } : {}),
        },
      });
    }
    const department = await db.department.create({ data: { name: `t20-dept-${RUN_ID}-${crypto.randomUUID()}` } });
    createdDepartmentIds.add(department.id);
    await db.departmentRole.create({ data: { departmentId: department.id, roleId: role.id } });
    await db.userDepartment.create({ data: { userId: member.userId, departmentId: department.id } });

    const body = (await (await callHolders(caller.token)).json()) as HoldersBody;
    const byId = new Map(body.users.map((u) => [u.id, u]));
    expect(byId.get(member.userId)?.unconditioned).toBe(false);
    expect(byId.has(bystander.userId)).toBe(false);
  });
});
