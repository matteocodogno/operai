/**
 * Integration tests for GET /authz/users/directory (T5, specs/015-hardware-
 * inventory — refs AC-2.1, AC-3.7; ADR-0047).
 *
 * WHY THIS FILE LIVES IN `src/auth/` and not next to the route in `src/authz/`
 * (the task's listed path): the real Bearer-token mint flow needs the real
 * `auth.config`, which sibling test files elsewhere `mock.module` for the rest
 * of the process — see `identities.routes.test.ts` and
 * `authz-resolve.routes.test.ts` in this directory for the confirmed hazard.
 * Same strategy as those: real session -> real RS256 token -> Bearer call.
 *
 * DB-ISOLATION: the user table is shared and holds other tests' fixtures, so
 * assertions look only at THIS run's fixture ids (and relative order among
 * them). Every user and role created here is deleted in `afterAll`.
 */

import { afterAll, describe, expect, test } from "bun:test";
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
const { directoryRouter } = await import("../authz/directory.routes");

const RUN_ID = crypto.randomUUID().slice(0, 8);
const createdUserIds = new Set<string>();
const createdRoleIds = new Set<string>();

afterAll(async () => {
  await db.role.deleteMany({ where: { id: { in: Array.from(createdRoleIds) } } });
  await db.user.deleteMany({ where: { id: { in: Array.from(createdUserIds) } } });
});

type Fixture = { userId: string; email: string; name: string; token: string };

async function mintUser(
  label: string,
  opts: {
    name?: string;
    entity?: string;
    grants?: { resource: string; action: string; conditions?: object }[];
    /** Keep the baseline `employee` role. Off by default: once seeded it carries meetings:access (specs/021), which opens the directory on its own. */
    keepBaselineRole?: boolean;
  } = {},
): Promise<Fixture> {
  const email = `t5-${label}-${RUN_ID}-${crypto.randomUUID()}@operai.test`;
  const name = opts.name ?? `T5 ${label} ${RUN_ID}`;

  const sessionRes = await testAuthRouter.request("/test-auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, name }),
  });
  expect(sessionRes.status).toBe(200);
  const { userId } = (await sessionRes.json()) as { userId: string };
  createdUserIds.add(userId);

  if (!opts.keepBaselineRole) {
    // The create hook gave the user `employee`; strip it so each case tests the named grant alone.
    await db.userRole.deleteMany({ where: { userId, role: { name: "employee" } } });
  }

  if (opts.entity !== undefined) {
    await db.user.update({ where: { id: userId }, data: { entity: opts.entity } });
  }

  if (opts.grants?.length) {
    const role = await db.role.create({ data: { name: `t5-role-${label}-${RUN_ID}-${crypto.randomUUID()}` } });
    createdRoleIds.add(role.id);
    for (const g of opts.grants) {
      await db.permissionRule.create({
        data: { roleId: role.id, resource: g.resource, action: g.action, ...(g.conditions ? { conditions: g.conditions as Prisma.InputJsonValue } : {}) },
      });
    }
    await db.userRole.create({ data: { userId, roleId: role.id } });
  }

  const cookiePair = ((sessionRes.headers.get("set-cookie") as string).split(";")[0]) ?? "";
  const tokenRes = await authRouter.request("/auth/token", { headers: { Cookie: cookiePair } });
  expect(tokenRes.status).toBe(200);
  const { token } = (await tokenRes.json()) as { token: string };
  return { userId, email, name, token };
}

const callDirectory = (token: string | undefined) =>
  directoryRouter.request("/authz/users/directory", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

type DirectoryBody = { users: { id: string; name: string | null; email: string; entity: string | null }[] };

const ENTITY_CONDITION = { attributes: [{ key: "entity", match: "user" }] };

describe("GET /authz/users/directory (T5, specs/015-hardware-inventory; ADR-0047)", () => {
  test("a holder of asset:manage gets active users of BOTH entities, each with exactly id/name/email/entity", async () => {
    const manager = await mintUser("mgr", {
      entity: "welld_ch",
      grants: [{ resource: "asset", action: "manage", conditions: ENTITY_CONDITION }],
    });
    const itUser = await mintUser("it", { entity: "welld_it" });
    const chUser = await mintUser("ch", { entity: "welld_ch" });
    const noEntity = await mintUser("noent");

    const res = await callDirectory(manager.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DirectoryBody;

    expect(Object.keys(body)).toEqual(["users"]);
    const byId = new Map(body.users.map((u) => [u.id, u]));

    // Entity-scoped manager (welld_ch) still sees the other entity's people: ADR-0047 point 4.
    expect(byId.get(itUser.userId)).toEqual({
      id: itUser.userId,
      name: itUser.name,
      email: itUser.email,
      entity: "welld_it",
    });
    expect(byId.get(chUser.userId)?.entity).toBe("welld_ch");
    expect(byId.get(noEntity.userId)?.entity).toBeNull();
    // The caller is listed too: a manager may assign a device to themselves.
    expect(byId.has(manager.userId)).toBe(true);

    // Exactly four fields on every row — adding one is an ADR change.
    for (const user of body.users) {
      expect(Object.keys(user).sort()).toEqual(["email", "entity", "id", "name"]);
    }
  });

  test("the response is not cacheable (it is a roster of personal data)", async () => {
    const manager = await mintUser("nocache", { grants: [{ resource: "asset", action: "manage" }] });
    const res = await callDirectory(manager.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("a soft-deleted user is absent", async () => {
    const manager = await mintUser("del-mgr", { grants: [{ resource: "asset", action: "manage" }] });
    const gone = await mintUser("gone");
    const stays = await mintUser("stays");
    await db.user.update({ where: { id: gone.userId }, data: { deletedAt: new Date() } });

    const body = (await (await callDirectory(manager.token)).json()) as DirectoryBody;
    const ids = body.users.map((u) => u.id);
    expect(ids).not.toContain(gone.userId);
    expect(ids).toContain(stays.userId);
  });

  test("is sorted by name (case- and accent-insensitive), regardless of creation order", async () => {
    const manager = await mintUser("sort-mgr", { grants: [{ resource: "asset", action: "manage" }] });
    // Created out of order on purpose; names share a run-unique prefix so they sort together.
    const zed = await mintUser("sz", { name: `${RUN_ID} Zeta` });
    const alpha = await mintUser("sa", { name: `${RUN_ID} alpha` });
    const eacute = await mintUser("se", { name: `${RUN_ID} Élodie` });
    const bravo = await mintUser("sb", { name: `${RUN_ID} Bravo` });

    const body = (await (await callDirectory(manager.token)).json()) as DirectoryBody;
    const mine = new Set([zed.userId, alpha.userId, eacute.userId, bravo.userId]);
    const order = body.users.filter((u) => mine.has(u.id)).map((u) => u.name);

    expect(order).toEqual([`${RUN_ID} alpha`, `${RUN_ID} Bravo`, `${RUN_ID} Élodie`, `${RUN_ID} Zeta`]);
  });

  test("a caller with only ledger:manage gets 403 — the gate is asset:manage, not 'any inventory permission'", async () => {
    const accountant = await mintUser("ledger-only", {
      grants: [
        { resource: "inventory", action: "access" },
        { resource: "ledger", action: "manage", conditions: ENTITY_CONDITION },
      ],
    });
    const res = await callDirectory(accountant.token);
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["status"]).toBe(403);
    expect(JSON.stringify(body)).not.toContain("@operai.test");
    expect(body["users"]).toBeUndefined();
  });

  test("a signed-in user with no inventory grants, and one holding only inventory:access, get 403", async () => {
    const plain = await mintUser("plain");
    const accessOnly = await mintUser("access-only", {
      grants: [{ resource: "inventory", action: "access" }],
    });
    expect((await callDirectory(plain.token)).status).toBe(403);
    expect((await callDirectory(accessOnly.token)).status).toBe(403);
  });

  // specs/017-crm, ADR-0053: the CRM's owner/assignee picker is the second consumer.
  test("a holder of the crm catalog's deal:manage (entity-scoped) gets the roster", async () => {
    const sales = await mintUser("crm-sales", {
      grants: [
        { resource: "crm", action: "access" },
        { resource: "deal", action: "manage", conditions: ENTITY_CONDITION },
      ],
    });
    const res = await callDirectory(sales.token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as DirectoryBody).users.some((u) => u.id === sales.userId)).toBe(true);
  });

  test("crm:access alone, or contact:erase, does NOT open the directory (ADR-0053)", async () => {
    const reader = await mintUser("crm-reader", { grants: [{ resource: "crm", action: "access" }] });
    const eraser = await mintUser("crm-eraser", {
      grants: [
        { resource: "crm", action: "access" },
        { resource: "contact", action: "erase" },
      ],
    });
    expect((await callDirectory(reader.token)).status).toBe(403);
    expect((await callDirectory(eraser.token)).status).toBe(403);
  });

  // specs/021-meetings, ADR-0066: the third consumer is the meeting participant picker.
  test("a caller holding only meetings:access gets 200 and the unfiltered list (ADR-0066)", async () => {
    const attendee = await mintUser("mtg-only", { entity: "welld_ch", grants: [{ resource: "meetings", action: "access" }] });
    // Neither of these holds any tool grant: a participant needs none (AC-10.4), so all must be pickable.
    const itUser = await mintUser("mtg-it", { entity: "welld_it" });
    const noEntity = await mintUser("mtg-noent");

    const res = await callDirectory(attendee.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DirectoryBody;
    const byId = new Map(body.users.map((u) => [u.id, u]));
    expect(byId.has(attendee.userId)).toBe(true);
    expect(byId.get(itUser.userId)?.entity).toBe("welld_it");
    expect(byId.has(noEntity.userId)).toBe(true);
    for (const user of body.users) expect(Object.keys(user).sort()).toEqual(["email", "entity", "id", "name"]);
  });

  test("template:manage, meeting:erase or a meetings lookalike alone do NOT open the directory (ADR-0066)", async () => {
    const admin = await mintUser("mtg-admin-caps", {
      grants: [
        { resource: "template", action: "manage" },
        { resource: "meeting", action: "erase" },
      ],
    });
    const lookalike = await mintUser("mtg-lookalike", {
      grants: [
        { resource: "meetings", action: "view" },
        { resource: "meeting", action: "access" },
      ],
    });
    expect((await callDirectory(admin.token)).status).toBe(403);
    expect((await callDirectory(lookalike.token)).status).toBe(403);
  });

  test("revoking meetings:access closes the directory immediately", async () => {
    const attendee = await mintUser("mtg-revoked", { grants: [{ resource: "meetings", action: "access" }] });
    expect((await callDirectory(attendee.token)).status).toBe(200);
    await db.userRole.deleteMany({ where: { userId: attendee.userId, role: { name: { startsWith: "t5-role-mtg-revoked" } } } });
    expect((await callDirectory(attendee.token)).status).toBe(403);
  });

  // specs/025-projects, ADR-0055: the project manager / team pickers are the fourth consumer.
  test("a holder of the projects catalog's project:manage (entity-scoped) gets the roster", async () => {
    const manager = await mintUser("projects-manager", {
      grants: [
        { resource: "projects", action: "access" },
        { resource: "project", action: "manage", conditions: ENTITY_CONDITION },
      ],
    });
    const res = await callDirectory(manager.token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as DirectoryBody).users.some((u) => u.id === manager.userId)).toBe(true);
  });

  test("projects:access alone, or contract:bexio, does NOT open the directory", async () => {
    const reader = await mintUser("projects-reader", { grants: [{ resource: "projects", action: "access" }] });
    const accountant = await mintUser("projects-bexio", {
      grants: [
        { resource: "projects", action: "access" },
        { resource: "contract", action: "bexio" },
      ],
    });
    expect((await callDirectory(reader.token)).status).toBe(403);
    expect((await callDirectory(accountant.token)).status).toBe(403);
  });

  test("the grant is matched on resource AND action: asset:other / ledger:manage do not open it", async () => {
    const lookalike = await mintUser("lookalike", {
      grants: [
        { resource: "asset", action: "view" },
        { resource: "request", action: "manage" },
      ],
    });
    expect((await callDirectory(lookalike.token)).status).toBe(403);
  });

  test("a soft-deleted holder with a still-valid token gets 403 (ADR-0012 residual JWT)", async () => {
    const manager = await mintUser("deleted-holder", { grants: [{ resource: "asset", action: "manage" }] });
    expect((await callDirectory(manager.token)).status).toBe(200);

    await db.user.update({ where: { id: manager.userId }, data: { deletedAt: new Date() } });
    expect((await callDirectory(manager.token)).status).toBe(403);
  });

  test("revoking asset:manage takes effect immediately (live resolution, no cached grant)", async () => {
    const manager = await mintUser("revoked", { grants: [{ resource: "asset", action: "manage" }] });
    expect((await callDirectory(manager.token)).status).toBe(200);

    await db.userRole.deleteMany({ where: { userId: manager.userId, role: { name: { startsWith: "t5-role-revoked" } } } });
    expect((await callDirectory(manager.token)).status).toBe(403);
  });

  test("401 without a Bearer token, and with a garbage one", async () => {
    expect((await callDirectory(undefined)).status).toBe(401);
    expect((await callDirectory("not-a-jwt")).status).toBe(401);
  });

  test("the (limit+1)th request from one caller is 429 with Retry-After; another caller is unaffected", async () => {
    const heavy = await mintUser("rl-heavy", { grants: [{ resource: "asset", action: "manage" }] });
    const other = await mintUser("rl-other", { grants: [{ resource: "asset", action: "manage" }] });

    for (let i = 0; i < env.DIRECTORY_RATE_LIMIT; i++) {
      expect((await callDirectory(heavy.token)).status).toBe(200);
    }
    const over = await callDirectory(heavy.token);
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    const body = (await over.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("rate_limited");
    expect(body["users"]).toBeUndefined();

    expect((await callDirectory(other.token)).status).toBe(200);
  }, 60000);
});

// specs/018, ADR-0055: optional ?appId narrows the roster to holders of (appId,"access").
describe("GET /authz/users/directory?appId= (specs/018, ADR-0055)", () => {
  const callFiltered = (token: string, qs: string) =>
    directoryRouter.request(`/authz/users/directory${qs}`, { headers: { Authorization: `Bearer ${token}` } });

  test("returns only active users holding (appId,access); unknown appId yields an empty list; bad appId is 400", async () => {
    const appId = `t18-app-${RUN_ID}`;
    const sales = await mintUser("f-sales", {
      grants: [
        { resource: "deal", action: "manage", conditions: ENTITY_CONDITION },
        { resource: appId, action: "access" },
      ],
    });
    const holder = await mintUser("f-holder", { grants: [{ resource: appId, action: "access" }] });
    const other = await mintUser("f-other");
    const gone = await mintUser("f-gone", { grants: [{ resource: appId, action: "access" }] });
    await db.user.update({ where: { id: gone.userId }, data: { deletedAt: new Date() } });

    const res = await callFiltered(sales.token, `?appId=${appId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as DirectoryBody;
    expect(body.users.map((u) => u.id).sort()).toEqual([sales.userId, holder.userId].sort());
    expect(body.users.some((u) => u.id === other.userId || u.id === gone.userId)).toBe(false);
    for (const user of body.users) expect(Object.keys(user).sort()).toEqual(["email", "entity", "id", "name"]);

    const unknown = await callFiltered(sales.token, `?appId=nope-${RUN_ID}`);
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ users: [] });

    const invalid = await callFiltered(sales.token, "?appId=NOT%20VALID!!");
    expect(invalid.status).toBe(400);
  });

  test("the gate is unchanged: a non-holder gets 403 even with a valid appId", async () => {
    const nobody = await mintUser("f-nobody");
    expect((await callFiltered(nobody.token, "?appId=crm")).status).toBe(403);
  });
});
