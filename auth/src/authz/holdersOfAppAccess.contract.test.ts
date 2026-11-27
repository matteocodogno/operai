/**
 * AC-4.7 of specs/20261126-teams (contract half): `holdersOfAppAccess` is the batched form of the predicate
 * `POST /authz/app-access-check` applies one person at a time,
 * `resolveEffectivePermissions(id).some(p => p.resource === appId && p.action === "access")`. Both are run over the
 * same fixtures against REAL Postgres and must answer alike, person by person, so the two cannot drift: a direct
 * role, a role conferred by a department, a conditioned rule (conditions never narrow the access fact), another
 * action on the same resource, the same action on another resource, nothing at all, and a soft-deleted person
 * (the resolver does not look at `deletedAt`, so neither does the batch: the caller decides who is active).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { db } from "../lib/db";
import { holdersOfAppAccess, resolveEffectivePermissions } from "./resolver";

const RUN = crypto.randomUUID().slice(0, 8);
const APP = `app${RUN}`;
const OTHER_APP = `other${RUN}`;

const userIds: string[] = [];
const roleIds: string[] = [];
const departmentIds: string[] = [];

async function makeUser(label: string, deletedAt: Date | null = null) {
  const user = await db.user.create({
    data: { name: `H ${label}`, email: `holders-${label}-${RUN}@operai.test`, emailVerified: true, deletedAt },
  });
  userIds.push(user.id);
  return user.id;
}
async function makeRole(label: string, rules: { resource: string; action: string; conditions?: object }[]) {
  const role = await db.role.create({
    data: {
      name: `holders-${label}-${RUN}`,
      rules: {
        create: rules.map((r) => ({
          resource: r.resource,
          action: r.action,
          ...(r.conditions ? { conditions: r.conditions } : {}),
        })),
      },
    },
  });
  roleIds.push(role.id);
  return role.id;
}
async function makeDepartment(label: string, roleId: string) {
  const dept = await db.department.create({
    data: { name: `holders-${label}-${RUN}`, departmentRoles: { create: [{ roleId }] } },
  });
  departmentIds.push(dept.id);
  return dept.id;
}

const fixtures: Record<string, string> = {};

beforeAll(async () => {
  const unconditioned = await makeRole("uncond", [{ resource: APP, action: "access" }]);
  const conditioned = await makeRole("cond", [
    { resource: APP, action: "access", conditions: { ownership: "own", attributes: [{ key: "entity", match: "user" }] } },
  ]);
  const otherAction = await makeRole("other-action", [
    { resource: APP, action: "read" },
    { resource: APP, action: "manage" },
  ]);
  const otherResource = await makeRole("other-resource", [{ resource: OTHER_APP, action: "access" }]);
  const empty = await makeRole("empty", []);
  const viaDeptRole = await makeRole("dept", [{ resource: APP, action: "access" }]);
  const dept = await makeDepartment("dept", viaDeptRole);
  const deptNoAccessRole = await makeRole("dept-no", [{ resource: APP, action: "read" }]);
  const deptNo = await makeDepartment("dept-no", deptNoAccessRole);

  fixtures["direct"] = await makeUser("direct");
  await db.userRole.create({ data: { userId: fixtures["direct"], roleId: unconditioned } });
  fixtures["conditioned"] = await makeUser("conditioned");
  await db.userRole.create({ data: { userId: fixtures["conditioned"], roleId: conditioned } });
  fixtures["department"] = await makeUser("department");
  await db.userDepartment.create({ data: { userId: fixtures["department"], departmentId: dept } });
  fixtures["both"] = await makeUser("both");
  await db.userRole.create({ data: { userId: fixtures["both"], roleId: unconditioned } });
  await db.userDepartment.create({ data: { userId: fixtures["both"], departmentId: dept } });
  fixtures["otherAction"] = await makeUser("other-action");
  await db.userRole.create({ data: { userId: fixtures["otherAction"], roleId: otherAction } });
  fixtures["otherResource"] = await makeUser("other-resource");
  await db.userRole.create({ data: { userId: fixtures["otherResource"], roleId: otherResource } });
  fixtures["emptyRole"] = await makeUser("empty-role");
  await db.userRole.create({ data: { userId: fixtures["emptyRole"], roleId: empty } });
  fixtures["deptWithoutAccess"] = await makeUser("dept-no");
  await db.userDepartment.create({ data: { userId: fixtures["deptWithoutAccess"], departmentId: deptNo } });
  fixtures["nothing"] = await makeUser("nothing");
  fixtures["deletedDirect"] = await makeUser("deleted-direct", new Date());
  await db.userRole.create({ data: { userId: fixtures["deletedDirect"], roleId: unconditioned } });
  fixtures["deletedNothing"] = await makeUser("deleted-nothing", new Date());
  fixtures["unknown"] = `nobody-${RUN}`;
});

afterAll(async () => {
  await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await db.userDepartment.deleteMany({ where: { userId: { in: userIds } } });
  await db.departmentRole.deleteMany({ where: { departmentId: { in: departmentIds } } });
  await db.department.deleteMany({ where: { id: { in: departmentIds } } });
  await db.role.deleteMany({ where: { id: { in: roleIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

const oneAtATime = async (appId: string, id: string) =>
  (await Effect.runPromise(resolveEffectivePermissions(id))).some(
    (p) => p.resource === appId && p.action === "access",
  );
const batched = async (appId: string, ids: string[]) => Effect.runPromise(holdersOfAppAccess(appId, ids));

describe("holdersOfAppAccess equals resolveEffectivePermissions(...).some(...) (AC-4.7)", () => {
  test("every fixture, person by person, for the app, another app and an absent one", async () => {
    const ids = Object.values(fixtures);
    for (const appId of [APP, OTHER_APP, `absent${RUN}`]) {
      const holders = await batched(appId, ids);
      for (const [label, id] of Object.entries(fixtures)) {
        expect([label, holders.has(id)]).toEqual([label, await oneAtATime(appId, id)]);
      }
    }
  });

  test("the fixtures cover both answers (the comparison is not vacuous)", async () => {
    const holders = await batched(APP, Object.values(fixtures));
    const yes = Object.entries(fixtures)
      .filter(([, id]) => holders.has(id))
      .map(([label]) => label)
      .sort();
    expect(yes).toEqual(["both", "conditioned", "deletedDirect", "department", "direct"]);
  });

  test("a person is answered the same alone as inside a batch, and in any order", async () => {
    const ids = Object.values(fixtures);
    const reversed = [...ids].reverse();
    expect([...(await batched(APP, ids))].sort()).toEqual([...(await batched(APP, reversed))].sort());
    expect([...(await batched(APP, [fixtures["direct"]!]))]).toEqual([fixtures["direct"]!]);
    expect([...(await batched(APP, [fixtures["nothing"]!]))]).toEqual([]);
  });

  test("a repeated id is answered once; an empty list is the empty set", async () => {
    const holders = await batched(APP, [fixtures["direct"]!, fixtures["direct"]!, fixtures["direct"]!]);
    expect([...holders]).toEqual([fixtures["direct"]!]);
    expect((await batched(APP, [])).size).toBe(0);
  });

  test("the largest batch the teams read can make (50 teams x 100 members) is one call, not a bind-parameter error", async () => {
    const many = Array.from({ length: 5000 }, (_, i) => `synthetic-${RUN}-${i}`);
    const holders = await batched(APP, [...many, fixtures["direct"]!]);
    expect([...holders]).toEqual([fixtures["direct"]!]);
  });

  test("only the people asked about are ever answered", async () => {
    const holders = await batched(APP, [fixtures["nothing"]!, fixtures["direct"]!]);
    expect(holders.has(fixtures["department"]!)).toBe(false);
    expect(holders.size).toBe(1);
  });
});
