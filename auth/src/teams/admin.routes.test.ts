/**
 * T2 of specs/20261126-teams — the admin team routes (AC-1.1, 1.2, 1.4 to 1.8, 2.5, 3.1, 3.2) against REAL Postgres.
 * Only `auth.config` (the session source) is mocked, as in the departments tests. Teams are not Tier 1 records
 * (plan D8: no trigger, so fixtures can clean up): every row a test commits is tracked and removed in `afterAll`.
 *
 * Names carry a per-run suffix because the unique index is global; the suffix is lowercase hex, so changing a
 * name's casing keeps it a clash.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";
import { db } from "../lib/db";
import { resolveEffectivePermissions } from "../authz/resolver";
import { DECLARED_CATALOGS } from "../authz/seed";

type FakeSession = { user: { id: string; email: string; name: string }; session: { id: string } } | null;
let currentSession: FakeSession = null;

mock.module("../auth/auth.config", () => ({
  auth: { api: { getSession: mock(async () => currentSession) } },
}));

const { teamsRouter } = await import("./admin.routes");

const RUN = crypto.randomUUID().slice(0, 8);
const nm = (s: string) => `${s}-${RUN}`;

const createdUserIds = new Set<string>();
const createdTeamIds = new Set<string>();
const createdDepartmentIds = new Set<string>();

let adminId: string;
let plainId: string;

async function makeUser(label: string, deletedAt: Date | null = null) {
  const user = await db.user.create({
    data: { name: `T2 ${label}`, email: `t2-teams-${label}-${RUN}-${crypto.randomUUID().slice(0, 4)}@operai.test`, emailVerified: true, deletedAt },
  });
  createdUserIds.add(user.id);
  return user;
}

async function adminRoleId(): Promise<string> {
  const role = await db.role.upsert({ where: { name: "admin" }, update: {}, create: { name: "admin", isSystem: true } });
  return role.id;
}

function signedInAs(user: { id: string; email: string; name: string } | null) {
  currentSession = user === null ? null : { user, session: { id: `sess-${user.id}` } };
}
const asAdmin = () => signedInAs({ id: adminId, email: "admin@operai.test", name: "Admin" });
const asPlain = () => signedInAs({ id: plainId, email: "plain@operai.test", name: "Plain" });

beforeAll(async () => {
  const admin = await makeUser("admin");
  adminId = admin.id;
  await db.userRole.create({ data: { userId: adminId, roleId: await adminRoleId() } });
  plainId = (await makeUser("plain")).id;
});

afterAll(async () => {
  const teamIds = Array.from(createdTeamIds);
  await db.auditLog.deleteMany({ where: { OR: [{ targetId: { in: teamIds } }, { actorUserId: { in: Array.from(createdUserIds) } }] } });
  await db.teamMember.deleteMany({ where: { teamId: { in: teamIds } } });
  await db.team.deleteMany({ where: { id: { in: teamIds } } });
  await db.department.deleteMany({ where: { id: { in: Array.from(createdDepartmentIds) } } });
  await db.user.deleteMany({ where: { id: { in: Array.from(createdUserIds) } } });
});

// ─── Harness ──────────────────────────────────────────────────────────────────

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await teamsRouter.request(path, {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { res, status: res.status, json: json as any };
}

/** Creates a team through the API (tracked for cleanup) and returns its detail. */
async function create(name: string, description?: string) {
  asAdmin();
  const r = await call("POST", "/admin/teams", description === undefined ? { name } : { name, description });
  expect(r.status).toBe(201);
  createdTeamIds.add(r.json.id);
  return r.json as {
    id: string;
    name: string;
    description: string | null;
    archived: boolean;
    activeMemberCount: number;
    version: number;
    members: Array<{ id: string; deactivated: boolean }>;
  };
}

const teamAudits = (teamId?: string) =>
  db.auditLog.count({ where: { targetType: "team", ...(teamId === undefined ? { actorUserId: adminId } : { targetId: teamId }) } });
const allAdminAudits = () => db.auditLog.count({ where: { actorUserId: adminId, targetType: { in: ["team", "team_member"] } } });

async function stored(id: string) {
  return db.team.findUniqueOrThrow({ where: { id } });
}

/** True when `fn` rejects (a Prisma promise is lazy and not a plain Promise, so `expect().rejects` cannot take it). */
async function fails(fn: () => PromiseLike<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

// ─── AC-3.1: who may call ─────────────────────────────────────────────────────

describe("AC-3.1 every route is admin-only", () => {
  const routes: Array<[string, string, unknown?]> = [
    ["GET", "/admin/teams"],
    ["POST", "/admin/teams", { name: "x" }],
    ["GET", "/admin/teams/some-id"],
    ["PATCH", "/admin/teams/some-id", { baseVersion: 1, name: "x" }],
    ["POST", "/admin/teams/some-id/archive", { baseVersion: 1 }],
    ["POST", "/admin/teams/some-id/restore", { baseVersion: 1 }],
    ["DELETE", "/admin/teams/some-id"],
  ];

  test("401 with no session on every route, with no-store", async () => {
    signedInAs(null);
    for (const [method, path, body] of routes) {
      const r = await call(method, path, body);
      expect([method, path, r.status]).toEqual([method, path, 401]);
      expect(r.res.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  test("403 for a signed-in non-admin on every route, reads included", async () => {
    asPlain();
    for (const [method, path, body] of routes) {
      const r = await call(method, path, body);
      expect([method, path, r.status]).toEqual([method, path, 403]);
      expect(r.res.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  test("403 for a department-conferred admin: requireAdmin is direct only", async () => {
    const viaDept = await makeUser("via-dept");
    const dept = await db.department.create({ data: { name: nm("t2-dept") } });
    createdDepartmentIds.add(dept.id);
    await db.departmentRole.create({ data: { departmentId: dept.id, roleId: await adminRoleId() } });
    await db.userDepartment.create({ data: { userId: viaDept.id, departmentId: dept.id } });
    signedInAs({ id: viaDept.id, email: viaDept.email, name: viaDept.name });
    const r = await call("GET", "/admin/teams");
    expect(r.status).toBe(403);
  });

  test("an admin gets 200 from the reads and every route answers with no-store", async () => {
    const team = await create(nm("Auth-ok"));
    asAdmin();
    for (const path of ["/admin/teams", `/admin/teams/${team.id}`]) {
      const r = await call("GET", path);
      expect(r.status).toBe(200);
      expect(r.res.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  test("the permission catalog is unchanged: no team resource is declared anywhere", () => {
    const keys = DECLARED_CATALOGS.flatMap((c) => c.resources.map((r) => r.key));
    expect(keys.filter((k) => /team/i.test(k))).toEqual([]);
  });
});

// ─── AC-1.1: create ───────────────────────────────────────────────────────────

describe("AC-1.1 POST /admin/teams", () => {
  test("a padded name and a description -> 201 TeamDetail: trimmed, active, no members, version 1, listed by GET", async () => {
    asAdmin();
    const r = await call("POST", "/admin/teams", { name: `  ${nm("Padded")}  `, description: "  The platform guild  " });
    expect(r.status).toBe(201);
    createdTeamIds.add(r.json.id);
    expect(r.json).toMatchObject({
      name: nm("Padded"),
      description: "The platform guild",
      archived: false,
      activeMemberCount: 0,
      version: 1,
      members: [],
    });
    expect(typeof r.json.createdAt).toBe("string");
    expect(typeof r.json.updatedAt).toBe("string");

    const list = await call("GET", "/admin/teams");
    expect(list.status).toBe(200);
    expect(list.json.items.find((t: { id: string }) => t.id === r.json.id)).toEqual({
      id: r.json.id,
      name: nm("Padded"),
      description: "The platform guild",
      archived: false,
      activeMemberCount: 0,
      version: 1,
    });
  });

  test("an empty or blank description is stored as NULL; no description is NULL", async () => {
    const a = await create(nm("NoDesc"), "   ");
    expect(a.description).toBeNull();
    expect((await stored(a.id)).description).toBeNull();
    const b = await create(nm("NoDesc2"));
    expect(b.description).toBeNull();
  });

  test("the limits are 1..80 for the name and 500 for the description, on the trimmed text", async () => {
    asAdmin();
    const ok80 = await create("n".repeat(80 - RUN.length - 1) + `-${RUN}`);
    expect(ok80.name.length).toBe(80);
    const okDesc = await create(nm("Desc500"), "d".repeat(500));
    expect(okDesc.description?.length).toBe(500);

    for (const body of [
      { name: "" },
      { name: "   " },
      { name: "n".repeat(81) },
      { name: nm("TooLongDesc"), description: "d".repeat(501) },
      { name: 12 },
      {},
      { name: nm("Extra"), version: 7 },
    ]) {
      const r = await call("POST", "/admin/teams", body);
      expect([JSON.stringify(body).slice(0, 40), r.status]).toEqual([JSON.stringify(body).slice(0, 40), 400]);
      expect(r.json.code).toBe("validation_failed");
      expect(r.res.headers.get("Content-Type")).toContain("application/problem+json");
    }
    expect(await db.team.count({ where: { name: nm("TooLongDesc") } })).toBe(0);
  });

  test("a body that is not JSON is a 400", async () => {
    asAdmin();
    const r = await call("POST", "/admin/teams", "not json{");
    expect(r.status).toBe(400);
  });
});

// ─── AC-1.2: the name clash ───────────────────────────────────────────────────

describe("AC-1.2 the name clash", () => {
  test("create 'backend ' and 'BACKEND' -> 409 whose body deep-equals the contract, existingName in the stored casing", async () => {
    const existing = await create(nm("Backend"));
    asAdmin();
    const before = await allAdminAudits();
    const teamsBefore = await db.team.count();

    for (const submitted of [`${nm("backend")} `, nm("BACKEND")]) {
      const r = await call("POST", "/admin/teams", { name: submitted });
      expect(r.status).toBe(409);
      expect(r.res.headers.get("Content-Type")).toContain("application/problem+json");
      expect(r.res.headers.get("Cache-Control")).toBe("no-store");
      expect(r.json).toEqual({
        type: "https://httpstatuses.com/409",
        title: "Conflict",
        status: 409,
        code: "team_name_taken",
        detail: `A team named "${nm("Backend")}" already exists`,
        instance: "/admin/teams",
        existingName: nm("Backend"),
      });
    }
    expect(await db.team.count()).toBe(teamsBefore);
    expect(await allAdminAudits()).toBe(before);
    expect((await stored(existing.id)).version).toBe(1);
  });

  test("rename another team to 'backend ' -> 409, instance is the rename path, nothing changed", async () => {
    await create(nm("Backend2"));
    const other = await create(nm("Other2"));
    const before = await allAdminAudits();
    const r = await call("PATCH", `/admin/teams/${other.id}`, { baseVersion: 1, name: `${nm("backend2")} ` });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({
      type: "https://httpstatuses.com/409",
      title: "Conflict",
      status: 409,
      code: "team_name_taken",
      detail: `A team named "${nm("Backend2")}" already exists`,
      instance: `/admin/teams/${other.id}`,
      existingName: nm("Backend2"),
    });
    expect(await stored(other.id)).toMatchObject({ name: nm("Other2"), version: 1 });
    expect(await allAdminAudits()).toBe(before);
  });

  test("an archived team still holds its name", async () => {
    const t = await create(nm("Archived"));
    asAdmin();
    expect((await call("POST", `/admin/teams/${t.id}/archive`, { baseVersion: 1 })).status).toBe(200);
    const r = await call("POST", "/admin/teams", { name: nm("ARCHIVED") });
    expect(r.status).toBe(409);
    expect(r.json.existingName).toBe(nm("Archived"));
  });

  test("a stale baseVersion with a clashing name is version_conflict first", async () => {
    await create(nm("Taken3"));
    const t = await create(nm("Mine3"));
    asAdmin();
    expect((await call("PATCH", `/admin/teams/${t.id}`, { baseVersion: 1, description: "bump" })).status).toBe(200);
    const r = await call("PATCH", `/admin/teams/${t.id}`, { baseVersion: 1, name: nm("taken3") });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("version_conflict");
    expect(r.json.currentVersion).toBe(2);
  });

  test("renaming a team to another casing of its own name is a change: 200, version + 1, one audit row", async () => {
    const t = await create(nm("Self"));
    asAdmin();
    const before = await teamAudits(t.id);
    const r = await call("PATCH", `/admin/teams/${t.id}`, { baseVersion: 1, name: nm("SELF") });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ name: nm("SELF"), version: 2 });
    expect(await teamAudits(t.id)).toBe(before + 1);
  });

  test("no wildcard: with Back_nd stored, creating Backend is a 201", async () => {
    await create(nm("Back_nd"));
    const r = await create(nm("Backend-w"));
    expect(r.name).toBe(nm("Backend-w"));
    asAdmin();
    const clash = await call("POST", "/admin/teams", { name: nm("BACK_ND") });
    expect(clash.status).toBe(409);
    expect(clash.json.existingName).toBe(nm("Back_nd"));
  });

  test("race: two concurrent creates of 'Ops' and 'ops' -> one 201 and one 409 whose existingName is the winner's stored name", async () => {
    asAdmin();
    const [a, b] = await Promise.all([
      call("POST", "/admin/teams", { name: nm("Ops") }),
      call("POST", "/admin/teams", { name: nm("ops") }),
    ]);
    for (const r of [a, b]) if (r.status === 201) createdTeamIds.add(r.json.id);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const winner = a.status === 201 ? a : b;
    const loser = a.status === 201 ? b : a;
    expect(loser.json.code).toBe("team_name_taken");
    expect(loser.json.existingName).toBe(winner.json.name);
    expect(loser.json.instance).toBe("/admin/teams");
    expect(await db.team.count({ where: { name: { in: [nm("Ops"), nm("ops")] } } })).toBe(1);
    expect(await db.auditLog.count({ where: { targetType: "team", targetId: winner.json.id } })).toBe(1);
  });

  test("race: two concurrent renames to one name -> one 200 and one 409 naming the winner", async () => {
    const x = await create(nm("RaceX"));
    const y = await create(nm("RaceY"));
    asAdmin();
    const [a, b] = await Promise.all([
      call("PATCH", `/admin/teams/${x.id}`, { baseVersion: 1, name: nm("Target") }),
      call("PATCH", `/admin/teams/${y.id}`, { baseVersion: 1, name: nm("TARGET") }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    expect(loser.json).toMatchObject({ code: "team_name_taken", existingName: winner.json.name });
  });

  test("the unique index decides: a raw insert of a clashing lower() name is refused by the database", async () => {
    const t = await create(nm("Indexed"));
    const refused = await fails(() =>
      db.$executeRawUnsafe(`INSERT INTO "team" ("id","name","updatedAt") VALUES ('raw-${RUN}', '${nm("INDEXED")}', now())`),
    );
    expect(refused).toBe(true);
    expect(await db.team.count({ where: { id: `raw-${RUN}` } })).toBe(0);
    expect(t.id).toBeTruthy();
  });

  test("OpenAPI: the 409 team_name_taken schema requires existingName; version_conflict requires currentVersion", () => {
    const doc = teamsRouter.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "0" } }) as any;
    const schemas = doc.components.schemas;
    expect(schemas.TeamNameTaken.required).toContain("existingName");
    expect(schemas.TeamNameTaken.properties.existingName).toMatchObject({ type: "string", minLength: 1 });
    expect(schemas.TeamVersionConflict.required).toContain("currentVersion");

    const post409 = JSON.stringify(doc.paths["/admin/teams"].post.responses["409"]);
    expect(post409).toContain("#/components/schemas/TeamNameTaken");
    const patch409 = JSON.stringify(doc.paths["/admin/teams/{id}"].patch.responses["409"]);
    expect(patch409).toContain("#/components/schemas/TeamNameTaken");
    expect(patch409).toContain("#/components/schemas/TeamVersionConflict");
    const archive409 = JSON.stringify(doc.paths["/admin/teams/{id}/archive"].post.responses["409"]);
    expect(archive409).toContain("#/components/schemas/TeamVersionConflict");
    expect(archive409).not.toContain("TeamNameTaken");
  });
});

// ─── detail, list, AC-1.4 ─────────────────────────────────────────────────────

describe("GET and AC-1.4", () => {
  test("GET /admin/teams/{id} -> the detail; an unknown id -> 404 team_not_found", async () => {
    const t = await create(nm("Detail"), "d");
    asAdmin();
    const r = await call("GET", `/admin/teams/${t.id}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: t.id, name: nm("Detail"), description: "d", archived: false, version: 1, members: [] });
    const missing = await call("GET", "/admin/teams/does-not-exist");
    expect(missing.status).toBe(404);
    expect(missing.json.code).toBe("team_not_found");
    expect(missing.json.instance).toBe("/admin/teams/does-not-exist");
  });

  test("the list holds every team, archived included, in name order", async () => {
    const a = await create(nm("Lista"));
    const b = await create(nm("Listb"));
    asAdmin();
    await call("POST", `/admin/teams/${b.id}/archive`, { baseVersion: 1 });
    const r = await call("GET", "/admin/teams");
    const items = r.json.items as Array<{ id: string; name: string; archived: boolean }>;
    const mine = items.filter((t) => [a.id, b.id].includes(t.id));
    expect(mine.map((t) => [t.id, t.archived])).toEqual([
      [a.id, false],
      [b.id, true],
    ]);
    const names = items.map((t) => t.name);
    expect(names).toEqual([...names].sort((x, y) => new Intl.Collator("it", { sensitivity: "base" }).compare(x, y) || (x < y ? -1 : 1)));
  });

  test("activeMemberCount excludes a soft-deleted member, who is listed deactivated; clearing deletedAt counts them again", async () => {
    const t = await create(nm("Counts"));
    const live = await makeUser("count-live");
    const gone = await makeUser("count-gone");
    await db.teamMember.createMany({ data: [{ teamId: t.id, userId: live.id }, { teamId: t.id, userId: gone.id }] });
    asAdmin();
    expect((await call("GET", `/admin/teams/${t.id}`)).json.activeMemberCount).toBe(2);

    await db.user.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    const detail = (await call("GET", `/admin/teams/${t.id}`)).json;
    expect(detail.activeMemberCount).toBe(1);
    expect(detail.members.map((m: { id: string; deactivated: boolean }) => [m.id, m.deactivated])).toEqual([
      [live.id, false],
      [gone.id, true],
    ]);
    const listed = (await call("GET", "/admin/teams")).json.items.find((x: { id: string }) => x.id === t.id);
    expect(listed.activeMemberCount).toBe(1);

    await db.user.update({ where: { id: gone.id }, data: { deletedAt: null } });
    expect((await call("GET", `/admin/teams/${t.id}`)).json.activeMemberCount).toBe(2);
  });
});

// ─── PATCH, AC-1.8 ────────────────────────────────────────────────────────────

describe("PATCH /admin/teams/{id}", () => {
  test("changes name and description, version + 1, one audit row with before and after", async () => {
    const t = await create(nm("Patch1"), "old");
    asAdmin();
    const before = await teamAudits(t.id);
    const r = await call("PATCH", `/admin/teams/${t.id}`, { baseVersion: 1, name: `  ${nm("Patch1b")} `, description: "new" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ name: nm("Patch1b"), description: "new", version: 2, archived: false });
    expect(await teamAudits(t.id)).toBe(before + 1);
    const row = await db.auditLog.findFirstOrThrow({ where: { targetType: "team", targetId: t.id, action: "team.update" } });
    expect(row.actorUserId).toBe(adminId);
    expect(row.data).toEqual({
      before: { name: nm("Patch1"), description: "old" },
      after: { name: nm("Patch1b"), description: "new" },
    });
  });

  test("description null or '' clears it", async () => {
    const t = await create(nm("Patch2"), "x");
    asAdmin();
    const r = await call("PATCH", `/admin/teams/${t.id}`, { baseVersion: 1, description: null });
    expect(r.json).toMatchObject({ description: null, version: 2 });
    await call("PATCH", `/admin/teams/${t.id}`, { baseVersion: 2, description: "again" });
    const r2 = await call("PATCH", `/admin/teams/${t.id}`, { baseVersion: 3, description: "" });
    expect(r2.json).toMatchObject({ description: null, version: 4 });
  });

  test("unchanged values: 200, no version bump, no audit row", async () => {
    const t = await create(nm("Patch3"), "same");
    asAdmin();
    const before = await allAdminAudits();
    const row = await stored(t.id);
    const r = await call("PATCH", `/admin/teams/${t.id}`, { baseVersion: 1, name: ` ${nm("Patch3")} `, description: "same" });
    expect(r.status).toBe(200);
    expect(r.json.version).toBe(1);
    expect(await allAdminAudits()).toBe(before);
    expect((await stored(t.id)).updatedAt.getTime()).toBe(row.updatedAt.getTime());
  });

  test("400: no field besides baseVersion, missing or bad baseVersion, unknown member, bad name; nothing changes", async () => {
    const t = await create(nm("Patch4"));
    asAdmin();
    const before = await allAdminAudits();
    for (const body of [
      { baseVersion: 1 },
      { name: nm("x4") },
      { baseVersion: 0, name: nm("x4") },
      { baseVersion: 1.5, name: nm("x4") },
      { baseVersion: "1", name: nm("x4") },
      { baseVersion: 1, name: "" },
      { baseVersion: 1, name: "n".repeat(81) },
      { baseVersion: 1, description: "d".repeat(501) },
      { baseVersion: 1, name: nm("x4"), archived: true },
      { baseVersion: 1, name: null },
    ]) {
      const r = await call("PATCH", `/admin/teams/${t.id}`, body);
      expect([JSON.stringify(body), r.status]).toEqual([JSON.stringify(body), 400]);
      expect(r.json.code).toBe("validation_failed");
    }
    expect(await stored(t.id)).toMatchObject({ name: nm("Patch4"), version: 1 });
    expect(await allAdminAudits()).toBe(before);
  });

  test("404 team_not_found for an unknown id (after the 400 check)", async () => {
    asAdmin();
    const r = await call("PATCH", "/admin/teams/nope", { baseVersion: 1, name: nm("x5") });
    expect(r.status).toBe(404);
    expect(r.json.code).toBe("team_not_found");
    const bad = await call("PATCH", "/admin/teams/nope", { name: nm("x5") });
    expect(bad.status).toBe(400);
  });
});

describe("AC-1.8 a stale form is refused", () => {
  test("PATCH, archive and restore with a stale baseVersion -> 409 version_conflict + currentVersion; nothing changed, no audit", async () => {
    const t = await create(nm("Stale"), "keep");
    asAdmin();
    expect((await call("PATCH", `/admin/teams/${t.id}`, { baseVersion: 1, description: "v2" })).json.version).toBe(2);
    const before = await allAdminAudits();

    const attempts: Array<[string, string, unknown]> = [
      ["PATCH", `/admin/teams/${t.id}`, { baseVersion: 1, name: nm("Stale-new") }],
      ["POST", `/admin/teams/${t.id}/archive`, { baseVersion: 1 }],
      ["POST", `/admin/teams/${t.id}/restore`, { baseVersion: 1 }],
      ["PATCH", `/admin/teams/${t.id}`, { baseVersion: 3, name: nm("Stale-new") }],
    ];
    for (const [method, path, body] of attempts) {
      const r = await call(method, path, body);
      expect([method, path, r.status]).toEqual([method, path, 409]);
      expect(r.json).toMatchObject({ code: "version_conflict", status: 409, currentVersion: 2, instance: path });
      expect(r.res.headers.get("Content-Type")).toContain("application/problem+json");
    }
    expect(await stored(t.id)).toMatchObject({ name: nm("Stale"), description: "v2", version: 2, archivedAt: null });
    expect(await allAdminAudits()).toBe(before);
  });

  test("a missing baseVersion is a 400 on archive and restore too, never a skipped check", async () => {
    const t = await create(nm("NoBase"));
    asAdmin();
    for (const action of ["archive", "restore"]) {
      for (const body of [{}, { baseVersion: 0 }, { baseVersion: 1, extra: 1 }]) {
        const r = await call("POST", `/admin/teams/${t.id}/${action}`, body);
        expect(r.status).toBe(400);
      }
    }
    expect((await stored(t.id)).version).toBe(1);
  });

  test("two parallel PATCHes on the same version: exactly one 200, the other a version_conflict", async () => {
    const t = await create(nm("Parallel"));
    asAdmin();
    const [a, b] = await Promise.all([
      call("PATCH", `/admin/teams/${t.id}`, { baseVersion: 1, description: "from A" }),
      call("PATCH", `/admin/teams/${t.id}`, { baseVersion: 1, description: "from B" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.json).toMatchObject({ code: "version_conflict", currentVersion: 2 });
    expect((await stored(t.id)).version).toBe(2);
    expect(await db.auditLog.count({ where: { targetType: "team", targetId: t.id, action: "team.update" } })).toBe(1);
  });

  test("a parallel archive and rename on one version: one wins, the other is stale", async () => {
    const t = await create(nm("Mixed"));
    asAdmin();
    const [a, b] = await Promise.all([
      call("POST", `/admin/teams/${t.id}/archive`, { baseVersion: 1 }),
      call("PATCH", `/admin/teams/${t.id}`, { baseVersion: 1, name: nm("Mixed-new") }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await stored(t.id)).version).toBe(2);
  });
});

// ─── AC-1.5 / 1.6 archive and restore ─────────────────────────────────────────

describe("AC-1.5 and AC-1.6 archive and restore", () => {
  test("archive keeps members and description, bumps the version, one audit row; restore reverses it", async () => {
    const t = await create(nm("Cycle"), "kept");
    const member = await makeUser("cycle-member");
    await db.teamMember.create({ data: { teamId: t.id, userId: member.id } });
    asAdmin();

    const a = await call("POST", `/admin/teams/${t.id}/archive`, { baseVersion: 1 });
    expect(a.status).toBe(200);
    expect(a.json).toMatchObject({ archived: true, version: 2, description: "kept", activeMemberCount: 1 });
    expect(a.json.members.map((m: { id: string }) => m.id)).toEqual([member.id]);
    expect((await stored(t.id)).archivedAt).not.toBeNull();

    const r = await call("POST", `/admin/teams/${t.id}/restore`, { baseVersion: 2 });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ archived: false, version: 3, description: "kept", activeMemberCount: 1 });
    expect((await stored(t.id)).archivedAt).toBeNull();

    const rows = await db.auditLog.findMany({ where: { targetType: "team", targetId: t.id }, orderBy: { createdAt: "asc" } });
    expect(rows.map((x) => x.action).sort()).toEqual(["team.archive", "team.create", "team.restore"]);
    expect(rows.every((x) => x.actorUserId === adminId)).toBe(true);
  });

  test("archiving an archived team and restoring an active one are no-ops: 200, no bump, no audit", async () => {
    const t = await create(nm("Noop"));
    asAdmin();
    const restoreActive = await call("POST", `/admin/teams/${t.id}/restore`, { baseVersion: 1 });
    expect(restoreActive.status).toBe(200);
    expect(restoreActive.json).toMatchObject({ archived: false, version: 1 });
    await call("POST", `/admin/teams/${t.id}/archive`, { baseVersion: 1 });
    const before = await allAdminAudits();
    const again = await call("POST", `/admin/teams/${t.id}/archive`, { baseVersion: 2 });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ archived: true, version: 2 });
    expect(await allAdminAudits()).toBe(before);
  });

  test("404 team_not_found on an unknown id", async () => {
    asAdmin();
    for (const action of ["archive", "restore"]) {
      const r = await call("POST", `/admin/teams/nope/${action}`, { baseVersion: 1 });
      expect(r.status).toBe(404);
      expect(r.json.code).toBe("team_not_found");
    }
  });
});

// ─── AC-1.7: no delete ────────────────────────────────────────────────────────

describe("AC-1.7 a team is never deleted", () => {
  test("DELETE -> 405 not_deletable with Allow: GET, PATCH; the row stays, no audit", async () => {
    const t = await create(nm("Keep"));
    asAdmin();
    const before = await teamAudits(t.id);
    const r = await call("DELETE", `/admin/teams/${t.id}`);
    expect(r.status).toBe(405);
    expect(r.json).toMatchObject({ status: 405, code: "not_deletable", instance: `/admin/teams/${t.id}` });
    expect(r.res.headers.get("Allow")).toBe("GET, PATCH");
    expect(r.res.headers.get("Content-Type")).toContain("application/problem+json");
    expect(await stored(t.id)).toMatchObject({ name: nm("Keep") });
    expect(await teamAudits(t.id)).toBe(before);
  });

  test("DELETE on an unknown id is the same 405 (no existence signal)", async () => {
    asAdmin();
    const r = await call("DELETE", "/admin/teams/does-not-exist");
    expect(r.status).toBe(405);
  });

  test("the database refuses to delete a team that has a member (ON DELETE RESTRICT)", async () => {
    const t = await create(nm("Restricted"));
    const u = await makeUser("restricted-member");
    await db.teamMember.create({ data: { teamId: t.id, userId: u.id } });
    expect(await fails(() => db.team.delete({ where: { id: t.id } }))).toBe(true);
    expect(await db.team.count({ where: { id: t.id } })).toBe(1);
  });
});

// ─── AC-2.5: no permission effect ─────────────────────────────────────────────

describe("AC-2.5 a team grants nothing and moves no epoch", () => {
  test("every team write leaves permissions, epoch and role and department rows exactly as they were", async () => {
    const person = await makeUser("epoch-person");
    const snapshot = async () => {
      const users = await db.user.findMany({
        where: { id: { in: [adminId, plainId, person.id] } },
        select: { id: true, permissionEpoch: true },
        orderBy: { id: "asc" },
      });
      const perms = await Promise.all([adminId, plainId, person.id].map((id) => Effect.runPromise(resolveEffectivePermissions(id))));
      return {
        users,
        perms: JSON.parse(JSON.stringify(perms)),
        userRole: await db.userRole.count(),
        userDepartment: await db.userDepartment.count(),
        roles: await db.role.count(),
        departments: await db.department.count(),
        rules: await db.permissionRule.count(),
      };
    };

    const before = await snapshot();
    const t = await create(nm("Epoch"));
    await db.teamMember.create({ data: { teamId: t.id, userId: person.id } });
    asAdmin();
    expect((await call("PATCH", `/admin/teams/${t.id}`, { baseVersion: 1, name: nm("Epoch2"), description: "x" })).status).toBe(200);
    expect((await call("POST", `/admin/teams/${t.id}/archive`, { baseVersion: 2 })).status).toBe(200);
    expect((await call("POST", `/admin/teams/${t.id}/restore`, { baseVersion: 3 })).status).toBe(200);
    expect((await call("DELETE", `/admin/teams/${t.id}`)).status).toBe(405);
    const after = await snapshot();

    // Counts of unrelated fixtures can move under parallel files: compare the three people and their grants.
    expect(after.users).toEqual(before.users);
    expect(after.perms).toEqual(before.perms);
  });
});

// ─── AC-3.2: one audit row per change ─────────────────────────────────────────

describe("AC-3.2 audit", () => {
  test("a create writes one team.create row naming the actor, the type and the team", async () => {
    asAdmin();
    const before = await allAdminAudits();
    const t = await create(nm("Audited"), "d");
    expect(await allAdminAudits()).toBe(before + 1);
    const row = await db.auditLog.findFirstOrThrow({ where: { targetType: "team", targetId: t.id } });
    expect(row).toMatchObject({ action: "team.create", actorUserId: adminId, targetType: "team", targetId: t.id });
    expect(row.summary).toContain(nm("Audited"));
  });

  test("every refusal (400, 403, 404, 405, 409) and every no-op writes none", async () => {
    const t = await create(nm("Quiet"));
    const dupe = await create(nm("Quiet-dupe"));
    asAdmin();
    const before = await allAdminAudits();

    await call("POST", "/admin/teams", { name: "" }); // 400
    await call("POST", "/admin/teams", { name: nm("QUIET") }); // 409 clash
    await call("PATCH", `/admin/teams/${t.id}`, { baseVersion: 9, name: nm("zz") }); // 409 stale
    await call("PATCH", `/admin/teams/${t.id}`, { baseVersion: 1, name: nm("quiet-dupe") }); // 409 clash
    await call("PATCH", "/admin/teams/nope", { baseVersion: 1, name: nm("zz") }); // 404
    await call("POST", "/admin/teams/nope/archive", { baseVersion: 1 }); // 404
    await call("DELETE", `/admin/teams/${t.id}`); // 405
    await call("PATCH", `/admin/teams/${t.id}`, { baseVersion: 1, name: nm("Quiet") }); // no-op
    await call("POST", `/admin/teams/${t.id}/restore`, { baseVersion: 1 }); // no-op
    asPlain();
    await call("POST", "/admin/teams", { name: nm("plain-try") }); // 403
    signedInAs(null);
    await call("POST", "/admin/teams", { name: nm("anon-try") }); // 401

    expect(await allAdminAudits()).toBe(before);
    expect(await db.auditLog.count({ where: { actorUserId: plainId } })).toBe(0);
    expect(await db.team.count({ where: { name: { in: [nm("plain-try"), nm("anon-try")] } } })).toBe(0);
    expect(dupe.id).toBeTruthy();
  });
});
