/**
 * QE probe (specs/20261126-teams, qe-report.md): U+0000 in any text an admin team route takes (name, description, ids) must be a
 * 4xx, never a 500 (Postgres text cannot hold NUL). Real Postgres (`operai_auth_test`), session mocked as the other team tests do.
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
  const admin = await db.user.create({ data: { name: "QE nul admin", email: `qe-nul-${RUN}@operai.test`, emailVerified: true } });
  adminId = admin.id;
  const role = await db.role.upsert({ where: { name: "admin" }, update: {}, create: { name: "admin", isSystem: true } });
  await db.userRole.create({ data: { userId: adminId, roleId: role.id } });
  const team = await db.team.create({ data: { name: `QE nul ${RUN}` } });
  teamId = team.id;
  currentSession = { user: { id: adminId, email: `qe-nul-${RUN}@operai.test`, name: "QE" }, session: { id: `s-${RUN}` } };
});

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { actorUserId: adminId } });
  await db.team.deleteMany({ where: { id: teamId } });
  await db.user.deleteMany({ where: { id: adminId } });
});

const NUL = "a\u0000b";
async function call(method: string, path: string, body?: unknown) {
  const res = await teamsRouter.request(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  await res.text();
  return res.status;
}
const below500 = (status: number) => {
  expect(status).toBeGreaterThanOrEqual(400);
  expect(status).toBeLessThan(500);
};

describe("NUL on the admin team routes is a 4xx", () => {
  test("create with NUL in the name", async () => below500(await call("POST", "/admin/teams", { name: NUL })));
  test("create with NUL in the description", async () => below500(await call("POST", "/admin/teams", { name: `ok ${RUN}`, description: NUL })));
  test("add member with NUL user id", async () => below500(await call("POST", `/admin/teams/${teamId}/members`, { userId: NUL })));
  test("GET detail with a NUL id", async () => below500(await call("GET", `/admin/teams/${encodeURIComponent(NUL)}`)));
  test("remove member with a NUL id", async () => below500(await call("DELETE", `/admin/teams/${teamId}/members/${encodeURIComponent(NUL)}`)));
  test("PATCH with NUL in the name", async () => below500(await call("PATCH", `/admin/teams/${teamId}`, { baseVersion: 1, name: NUL })));
});

describe("harness sanity (the same harness accepts a clean request)", () => {
  test("clean create is 201, so the 500s above come from the NUL", async () => {
    const status = await call("POST", "/admin/teams", { name: `clean ${RUN}` });
    expect(status).toBe(201);
    await db.auditLog.deleteMany({ where: { actorUserId: adminId } });
    await db.team.deleteMany({ where: { name: `clean ${RUN}` } });
  });
});
