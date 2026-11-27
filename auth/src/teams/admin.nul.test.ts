/**
 * U+0000 in a team's text or in an id the admin routes take is a 400 `validation_failed` that echoes nothing of the input
 * (specs/20261126-teams, QE D1; the QE probe in `admin.nul.qe.test.ts` only asserts "not 5xx"). Real Postgres, session mocked.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { db } from "../lib/db";

type FakeSession = { user: { id: string; email: string; name: string }; session: { id: string } } | null;
let currentSession: FakeSession = null;
mock.module("../auth/auth.config", () => ({ auth: { api: { getSession: mock(async () => currentSession) } } }));
const { teamsRouter } = await import("./admin.routes");

const RUN = crypto.randomUUID().slice(0, 8);
let adminId = "";
let teamId = "";

beforeAll(async () => {
  const admin = await db.user.create({ data: { name: "nul admin", email: `nul-${RUN}@operai.test`, emailVerified: true } });
  adminId = admin.id;
  const role = await db.role.upsert({ where: { name: "admin" }, update: {}, create: { name: "admin", isSystem: true } });
  await db.userRole.create({ data: { userId: adminId, roleId: role.id } });
  teamId = (await db.team.create({ data: { name: `nul ${RUN}` } })).id;
  currentSession = { user: { id: adminId, email: `nul-${RUN}@operai.test`, name: "N" }, session: { id: `s-${RUN}` } };
});

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { actorUserId: adminId } });
  await db.team.deleteMany({ where: { id: teamId } });
  await db.user.deleteMany({ where: { id: adminId } });
});

const NUL = "zz\u0000qq";
async function call(method: string, path: string, body?: unknown) {
  const res = await teamsRouter.request(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, text: await res.text() };
}
const snapshot = async () => ({
  teams: await db.team.findMany({ orderBy: { id: "asc" } }),
  members: await db.teamMember.count(),
  audits: await db.auditLog.count({ where: { actorUserId: adminId } }),
});
const refused = (r: { status: number; text: string }) => {
  expect(r.status).toBe(400);
  const { instance: _instance, ...body } = JSON.parse(r.text) as Record<string, unknown>;
  expect(body.code).toBe("validation_failed");
  // `instance` is the request path by RFC 7807 convention (every error carries it); detail never repeats the value.
  expect(JSON.stringify(body)).not.toContain("zz");
};

async function refusedWritingNothing(method: string, path: string, body?: unknown) {
  const before = await snapshot();
  refused(await call(method, path, body));
  expect(await snapshot()).toEqual(before);
}

describe("a NUL on the admin team routes is a 400 that echoes nothing", () => {
  test("create, name", async () => await refusedWritingNothing("POST", "/admin/teams", { name: NUL }));
  test("create, description", async () => await refusedWritingNothing("POST", "/admin/teams", { name: `ok ${RUN}`, description: NUL }));
  test("patch, name", async () => await refusedWritingNothing("PATCH", `/admin/teams/${teamId}`, { baseVersion: 1, name: NUL }));
  test("patch, description", async () => await refusedWritingNothing("PATCH", `/admin/teams/${teamId}`, { baseVersion: 1, description: NUL }));
  test("add member, userId", async () => await refusedWritingNothing("POST", `/admin/teams/${teamId}/members`, { userId: NUL }));
  test("detail, id", async () => await refusedWritingNothing("GET", `/admin/teams/${encodeURIComponent(NUL)}`));
  test("remove member, userId", async () => await refusedWritingNothing("DELETE", `/admin/teams/${teamId}/members/${encodeURIComponent(NUL)}`));
  test("archive, id", async () => await refusedWritingNothing("POST", `/admin/teams/${encodeURIComponent(NUL)}/archive`, { baseVersion: 1 }));
  test("a clean unknown id is still a 404", async () => expect((await call("GET", "/admin/teams/nope")).status).toBe(404));
});
