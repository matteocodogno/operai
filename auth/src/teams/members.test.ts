/**
 * T3 of specs/20261126-teams — the member routes (AC-2.1 to 2.5, 3.2) against REAL Postgres. Only `auth.config`
 * (the session source) is mocked, as in `admin.routes.test.ts`. Every row a test commits is tracked and removed in
 * `afterAll` (plan D8: a team is no Tier 1 record, so fixtures can clean up).
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";
import { db } from "../lib/db";
import { resolveEffectivePermissions } from "../authz/resolver";

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

let adminId: string;
let plainId: string;

async function makeUser(label: string, deletedAt: Date | null = null) {
  const user = await db.user.create({
    data: { name: `T3 ${label}`, email: `t3-members-${label}-${RUN}-${crypto.randomUUID().slice(0, 4)}@operai.test`, emailVerified: true, deletedAt },
  });
  createdUserIds.add(user.id);
  return user;
}

function signedInAs(user: { id: string; email: string; name: string } | null) {
  currentSession = user === null ? null : { user, session: { id: `sess-${user.id}` } };
}
const asAdmin = () => signedInAs({ id: adminId, email: "admin@operai.test", name: "Admin" });
const asPlain = () => signedInAs({ id: plainId, email: "plain@operai.test", name: "Plain" });

beforeAll(async () => {
  const admin = await makeUser("admin");
  adminId = admin.id;
  const role = await db.role.upsert({ where: { name: "admin" }, update: {}, create: { name: "admin", isSystem: true } });
  await db.userRole.create({ data: { userId: adminId, roleId: role.id } });
  plainId = (await makeUser("plain")).id;
});

afterAll(async () => {
  const teamIds = Array.from(createdTeamIds);
  await db.auditLog.deleteMany({ where: { OR: [{ targetId: { in: teamIds } }, { actorUserId: { in: Array.from(createdUserIds) } }] } });
  await db.teamMember.deleteMany({ where: { teamId: { in: teamIds } } });
  await db.team.deleteMany({ where: { id: { in: teamIds } } });
  await db.user.deleteMany({ where: { id: { in: Array.from(createdUserIds) } } });
});

async function call(method: string, path: string, body?: unknown) {
  const res = await teamsRouter.request(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { res, status: res.status, json };
}

async function createTeam(name: string) {
  asAdmin();
  const r = await call("POST", "/admin/teams", { name });
  expect(r.status).toBe(201);
  createdTeamIds.add(r.json.id);
  return r.json as { id: string; version: number };
}

const add = (teamId: string, userId: string) => call("POST", `/admin/teams/${teamId}/members`, { userId });
const remove = (teamId: string, userId: string) => call("DELETE", `/admin/teams/${teamId}/members/${userId}`);
const memberAudits = (teamId: string) => db.auditLog.count({ where: { targetType: "team", targetId: teamId, action: { startsWith: "team_member." } } });
const allTeamAudits = () => db.auditLog.count({ where: { actorUserId: adminId, targetType: { in: ["team", "team_member"] } } });

/** Inserts `n` members straight into the table (fast fixture for the limit). */
async function fillMembers(teamId: string, n: number, label: string): Promise<string[]> {
  const stamp = crypto.randomUUID().slice(0, 6);
  const data = Array.from({ length: n }, (_, i) => ({
    name: `T3 ${label} ${i}`,
    email: `t3-fill-${label}-${stamp}-${i}@operai.test`,
    emailVerified: true,
  }));
  await db.user.createMany({ data });
  const users = await db.user.findMany({ where: { email: { in: data.map((d) => d.email) } }, select: { id: true } });
  for (const u of users) createdUserIds.add(u.id);
  await db.teamMember.createMany({ data: users.map((u) => ({ teamId, userId: u.id })) });
  return users.map((u) => u.id);
}

// ─── Who may call ─────────────────────────────────────────────────────────────

describe("member routes are admin-only", () => {
  test("401 without a session, 403 for a non-admin; nothing written", async () => {
    const t = await createTeam(nm("Guarded"));
    const person = await makeUser("guarded");
    signedInAs(null);
    expect((await add(t.id, person.id)).status).toBe(401);
    expect((await remove(t.id, person.id)).status).toBe(401);
    asPlain();
    const a = await add(t.id, person.id);
    expect(a.status).toBe(403);
    expect(a.res.headers.get("cache-control")).toBe("no-store");
    expect((await remove(t.id, person.id)).status).toBe(403);
    expect(await db.teamMember.count({ where: { teamId: t.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { actorUserId: plainId } })).toBe(0);
  });
});

// ─── AC-2.1 / AC-2.2 ──────────────────────────────────────────────────────────

describe("AC-2.1 add an active user", () => {
  test("200 TeamDetail: listed and counted, version untouched, no-store, one team_member.add audit naming the person", async () => {
    const t = await createTeam(nm("Add"));
    const ada = await makeUser("ada");
    asAdmin();
    const before = await memberAudits(t.id);
    const r = await add(t.id, ada.id);
    expect(r.status).toBe(200);
    expect(r.res.headers.get("cache-control")).toBe("no-store");
    expect(r.json.activeMemberCount).toBe(1);
    expect(r.json.version).toBe(t.version); // D6: members are outside the version
    expect(r.json.members).toHaveLength(1);
    expect(r.json.members[0]).toMatchObject({ id: ada.id, name: ada.name, email: ada.email, deactivated: false });
    expect(typeof r.json.members[0].addedAt).toBe("string");

    expect(await memberAudits(t.id)).toBe(before + 1);
    const row = await db.auditLog.findFirstOrThrow({ where: { targetType: "team", targetId: t.id, action: "team_member.add" } });
    expect(row).toMatchObject({ actorUserId: adminId, targetType: "team", targetId: t.id, data: { userId: ada.id } });
    expect(row.summary).toBe(`Added ${ada.email} to team "${nm("Add")}"`);

    const stored = await db.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: t.id, userId: ada.id } } });
    expect(stored.addedByUserId).toBe(adminId);
  });

  test("the same person may be in two teams", async () => {
    const a = await createTeam(nm("Two-A"));
    const b = await createTeam(nm("Two-B"));
    const p = await makeUser("two");
    asAdmin();
    expect((await add(a.id, p.id)).json.activeMemberCount).toBe(1);
    expect((await add(b.id, p.id)).json.activeMemberCount).toBe(1);
    expect(await db.teamMember.count({ where: { userId: p.id } })).toBe(2);
  });

  test("adding a member again is a no-op: 200, unchanged addedAt, no audit row", async () => {
    const t = await createTeam(nm("Again"));
    const p = await makeUser("again");
    asAdmin();
    const first = await add(t.id, p.id);
    const audits = await allTeamAudits();
    const second = await add(t.id, p.id);
    expect(second.status).toBe(200);
    expect(second.json.members).toHaveLength(1);
    expect(second.json.members[0].addedAt).toBe(first.json.members[0].addedAt);
    expect(await allTeamAudits()).toBe(audits);
  });

  test("an archived team accepts members (AC-2.4)", async () => {
    const t = await createTeam(nm("Archived-add"));
    asAdmin();
    expect((await call("POST", `/admin/teams/${t.id}/archive`, { baseVersion: t.version })).status).toBe(200);
    const p = await makeUser("archived-add");
    const r = await add(t.id, p.id);
    expect(r.status).toBe(200);
    expect(r.json.archived).toBe(true);
    expect(r.json.activeMemberCount).toBe(1);
    expect((await remove(t.id, p.id)).status).toBe(200);
  });
});

describe("AC-2.2 remove a member", () => {
  test("gone from this team only; the person's other team is unchanged; one team_member.remove audit", async () => {
    const a = await createTeam(nm("Rm-A"));
    const b = await createTeam(nm("Rm-B"));
    const p = await makeUser("rm");
    const q = await makeUser("rm-other");
    asAdmin();
    await add(a.id, p.id);
    await add(a.id, q.id);
    await add(b.id, p.id);
    const r = await remove(a.id, p.id);
    expect(r.status).toBe(200);
    expect(r.json.members.map((m: { id: string }) => m.id)).toEqual([q.id]);
    expect(r.json.activeMemberCount).toBe(1);
    expect(r.json.version).toBe(a.version);
    expect((await call("GET", `/admin/teams/${b.id}`)).json.members.map((m: { id: string }) => m.id)).toEqual([p.id]);

    const row = await db.auditLog.findFirstOrThrow({ where: { targetType: "team", targetId: a.id, action: "team_member.remove" } });
    expect(row).toMatchObject({ actorUserId: adminId, data: { userId: p.id } });
    expect(row.summary).toBe(`Removed ${p.email} from team "${nm("Rm-A")}"`);
  });

  test("removing a person who is not a member, or an unknown id, is a no-op: 200, no audit", async () => {
    const t = await createTeam(nm("Rm-noop"));
    const p = await makeUser("rm-noop");
    asAdmin();
    const audits = await allTeamAudits();
    const r = await remove(t.id, p.id);
    expect(r.status).toBe(200);
    expect(r.json.members).toEqual([]);
    expect((await remove(t.id, "no-such-user")).status).toBe(200);
    expect(await allTeamAudits()).toBe(audits);
  });

  test("a deactivated member can be removed, and the audit still names them", async () => {
    const t = await createTeam(nm("Rm-gone"));
    const p = await makeUser("rm-gone");
    asAdmin();
    await add(t.id, p.id);
    await db.user.update({ where: { id: p.id }, data: { deletedAt: new Date() } });
    const r = await remove(t.id, p.id);
    expect(r.status).toBe(200);
    expect(r.json.members).toEqual([]);
    const row = await db.auditLog.findFirstOrThrow({ where: { targetId: t.id, action: "team_member.remove" } });
    expect(row.summary).toContain(p.email);
  });
});

// ─── AC-2.3 ───────────────────────────────────────────────────────────────────

describe("AC-2.3 deactivated users", () => {
  test("an unknown and a soft-deleted id get one body: 422 user_not_active, no echo, nothing written", async () => {
    const t = await createTeam(nm("Inactive"));
    const gone = await makeUser("gone", new Date());
    asAdmin();
    const audits = await allTeamAudits();
    const unknown = await add(t.id, "no-such-user-id");
    const deleted = await add(t.id, gone.id);
    expect(unknown.status).toBe(422);
    expect(deleted.status).toBe(422);
    expect(unknown.res.headers.get("content-type")).toContain("application/problem+json");
    expect(unknown.json).toEqual({
      type: "https://httpstatuses.com/422",
      title: "Unprocessable Entity",
      status: 422,
      code: "user_not_active",
      detail: "Only an active user can be added to a team",
      instance: `/admin/teams/${t.id}/members`,
    });
    expect(deleted.json).toEqual(unknown.json);
    expect(JSON.stringify(deleted.json)).not.toContain(gone.id);
    expect(await db.teamMember.count({ where: { teamId: t.id } })).toBe(0);
    expect(await allTeamAudits()).toBe(audits);
  });

  test("a member deactivated later stays listed deactivated, uncounted, and counts again when deletedAt is cleared", async () => {
    const t = await createTeam(nm("Later"));
    const live = await makeUser("later-live");
    const p = await makeUser("later");
    asAdmin();
    await add(t.id, live.id);
    await add(t.id, p.id);
    await db.user.update({ where: { id: p.id }, data: { deletedAt: new Date() } });
    const detail = (await call("GET", `/admin/teams/${t.id}`)).json;
    expect(detail.activeMemberCount).toBe(1);
    expect(detail.members.map((m: { id: string; deactivated: boolean }) => [m.id, m.deactivated])).toEqual([
      [live.id, false],
      [p.id, true],
    ]);
    await db.user.update({ where: { id: p.id }, data: { deletedAt: null } });
    expect((await call("GET", `/admin/teams/${t.id}`)).json.activeMemberCount).toBe(2);
  });

  test("re-adding a member who is now deactivated is refused like any deactivated user", async () => {
    const t = await createTeam(nm("Readd-gone"));
    const p = await makeUser("readd-gone");
    asAdmin();
    await add(t.id, p.id);
    await db.user.update({ where: { id: p.id }, data: { deletedAt: new Date() } });
    expect((await add(t.id, p.id)).json.code).toBe("user_not_active");
  });
});

// ─── AC-2.4 ───────────────────────────────────────────────────────────────────

describe("AC-2.4 the limit of 100 counts deactivated members", () => {
  test("at 100 (one of them deactivated) an add is 422 team_full {limit:100}; a member already in is still a no-op", async () => {
    const t = await createTeam(nm("Full"));
    const ids = await fillMembers(t.id, 100, "full");
    await db.user.update({ where: { id: ids[0]! }, data: { deletedAt: new Date() } });
    const extra = await makeUser("full-extra");
    asAdmin();
    const audits = await allTeamAudits();

    const r = await add(t.id, extra.id);
    expect(r.status).toBe(422);
    expect(r.res.headers.get("content-type")).toContain("application/problem+json");
    expect(r.res.headers.get("cache-control")).toBe("no-store");
    expect(r.json).toEqual({
      type: "https://httpstatuses.com/422",
      title: "Unprocessable Entity",
      status: 422,
      code: "team_full",
      detail: "A team has at most 100 members, deactivated ones included",
      instance: `/admin/teams/${t.id}/members`,
      limit: 100,
    });
    expect(await db.teamMember.count({ where: { teamId: t.id } })).toBe(100);
    expect(await allTeamAudits()).toBe(audits);

    expect((await add(t.id, ids[1]!)).status).toBe(200); // already a member: no-op, not refused
    expect((await remove(t.id, ids[1]!)).status).toBe(200);
    expect((await add(t.id, extra.id)).status).toBe(200); // 99 now
  });

  test("the 100th member is accepted", async () => {
    const t = await createTeam(nm("Hundredth"));
    await fillMembers(t.id, 99, "hundredth");
    const p = await makeUser("hundredth");
    asAdmin();
    const r = await add(t.id, p.id);
    expect(r.status).toBe(200);
    expect(r.json.members).toHaveLength(100);
  });

  test("two concurrent adds at 99 make exactly one 200 and one 422, never 101", async () => {
    const t = await createTeam(nm("Race"));
    await fillMembers(t.id, 99, "race");
    const p1 = await makeUser("race-1");
    const p2 = await makeUser("race-2");
    asAdmin();
    const results = await Promise.all([add(t.id, p1.id), add(t.id, p2.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(results.find((r) => r.status === 422)!.json.code).toBe("team_full");
    expect(await db.teamMember.count({ where: { teamId: t.id } })).toBe(100);
  });

  test("two concurrent adds of the same person: one row, one audit row", async () => {
    const t = await createTeam(nm("Race-same"));
    const p = await makeUser("race-same");
    asAdmin();
    const results = await Promise.all([add(t.id, p.id), add(t.id, p.id)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await db.teamMember.count({ where: { teamId: t.id } })).toBe(1);
    expect(await memberAudits(t.id)).toBe(1);
  });
});

// ─── Refusals ─────────────────────────────────────────────────────────────────

describe("refusals of the member routes", () => {
  test("404 team_not_found for an unknown team (add and remove), whatever the user", async () => {
    const p = await makeUser("nf");
    asAdmin();
    for (const r of [await add("no-such-team", p.id), await add("no-such-team", "no-such-user"), await remove("no-such-team", p.id)]) {
      expect(r.status).toBe(404);
      expect(r.json.code).toBe("team_not_found");
    }
  });

  test("400 validation_failed: unknown member, missing, empty or over-long userId, wrong type, not JSON", async () => {
    const t = await createTeam(nm("Bad"));
    asAdmin();
    const bodies: unknown[] = [{}, { userId: "" }, { userId: "x".repeat(65) }, { userId: 7 }, { userId: "a", extra: 1 }];
    for (const body of bodies) {
      const r = await call("POST", `/admin/teams/${t.id}/members`, body);
      expect([JSON.stringify(body), r.status, r.json.code]).toEqual([JSON.stringify(body), 400, "validation_failed"]);
    }
    // A body that is not JSON is the framework's own 400 (as on the other routes, admin.routes.test.ts).
    expect((await call("POST", `/admin/teams/${t.id}/members`, "not json")).status).toBe(400);
    expect((await add(t.id, "x".repeat(64))).status).toBe(422); // 64 is allowed by the schema; unknown user
  });

  test("the add and remove answers are OpenAPI-declared with the 422 variants", async () => {
    const doc = teamsRouter.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "1" } }) as any;
    const post = doc.paths["/admin/teams/{id}/members"].post.responses;
    expect(Object.keys(post)).toEqual(expect.arrayContaining(["200", "400", "401", "403", "404", "422"]));
    expect(doc.paths["/admin/teams/{id}/members/{userId}"].delete.responses["200"]).toBeDefined();
  });
});

// ─── AC-2.5 / AC-3.2 ──────────────────────────────────────────────────────────

describe("AC-2.5 membership grants nothing and moves no epoch", () => {
  test("add and remove leave the person's permissions, epoch and role and department rows as they were", async () => {
    const t = await createTeam(nm("Epoch"));
    const person = await makeUser("epoch-person");
    const snapshot = async () => ({
      users: await db.user.findMany({ where: { id: { in: [adminId, person.id] } }, select: { id: true, permissionEpoch: true }, orderBy: { id: "asc" } }),
      perms: JSON.parse(JSON.stringify(await Promise.all([adminId, person.id].map((id) => Effect.runPromise(resolveEffectivePermissions(id)))))),
      userRoles: await db.userRole.count({ where: { userId: { in: [adminId, person.id] } } }),
      userDepartments: await db.userDepartment.count({ where: { userId: { in: [adminId, person.id] } } }),
    });
    const before = await snapshot();
    asAdmin();
    expect((await add(t.id, person.id)).status).toBe(200);
    expect((await add(t.id, adminId)).status).toBe(200); // the actor too
    expect((await remove(t.id, person.id)).status).toBe(200);
    expect(await snapshot()).toEqual(before);
  });

  test("the resolver reads neither team table", async () => {
    const source = await Bun.file(new URL("../authz/resolver.ts", import.meta.url)).text();
    expect(source).not.toMatch(/\bteam(Member)?\b/i);
  });
});

describe("AC-3.2 audit of the member writes", () => {
  test("each successful add and remove writes exactly one row; every refusal and no-op writes none", async () => {
    const t = await createTeam(nm("Audit"));
    const p = await makeUser("audit");
    const gone = await makeUser("audit-gone", new Date());
    asAdmin();
    const start = await allTeamAudits();

    await add(t.id, p.id);
    expect(await allTeamAudits()).toBe(start + 1);
    await remove(t.id, p.id);
    expect(await allTeamAudits()).toBe(start + 2);

    await add(t.id, p.id);
    const mark = await allTeamAudits();
    await add(t.id, p.id); // no-op
    await remove(t.id, "no-such-user"); // no-op
    await add(t.id, gone.id); // 422
    await add(t.id, "no-such-user"); // 422
    await add("no-such-team", p.id); // 404
    await remove("no-such-team", p.id); // 404
    await call("POST", `/admin/teams/${t.id}/members`, {}); // 400
    asPlain();
    await add(t.id, p.id); // 403
    signedInAs(null);
    await add(t.id, p.id); // 401
    expect(await allTeamAudits()).toBe(mark);
    expect(await db.auditLog.count({ where: { actorUserId: plainId } })).toBe(0);
  });

  test("a refused add at the limit writes no audit row", async () => {
    const t = await createTeam(nm("Audit-full"));
    await fillMembers(t.id, 100, "audit-full");
    const p = await makeUser("audit-full");
    asAdmin();
    const before = await memberAudits(t.id);
    expect((await add(t.id, p.id)).status).toBe(422);
    expect(await memberAudits(t.id)).toBe(before);
  });
});
