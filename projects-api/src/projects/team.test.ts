/**
 * The team of a project (specs/025 T7; AC-1.5, AC-1.6, AC-1.7, AC-4.4). Runs the ASSEMBLED app
 * against the `*_test` database; auth, its identity and app-access endpoints are the fakes of
 * test-support/world.ts. Projects are seeded straight in the database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { appAccess, call, db, forgetIdentities, identities, resetWorld, type PersonaName } from "../test-support/world";
import type { Prisma } from "../lib/generated/prisma/client";

beforeEach(resetWorld);

const seed = (over: Partial<Prisma.ProjectUncheckedCreateInput> = {}) =>
  db.project.create({
    data: {
      name: "Koordy",
      type: "internal",
      entity: "welld_ch",
      projectManagerId: "user-pm-ch",
      createdById: "user-pm-ch",
      ...over,
    },
  });

const putTeam = (id: string, memberIds: unknown, as: PersonaName | null = "pmCh", ifMatch: number | string = 1) =>
  call("PUT", `/projects/${id}/team`, { as, body: { memberIds }, ifMatch });

const memberIdsOf = async (projectId: string) =>
  (await db.projectMember.findMany({ where: { projectId }, orderBy: { userId: "asc" } })).map((m) => m.userId);

const person = (id: string) => ({ id, name: `Name of ${id}`, deleted: false });

describe("PUT /projects/:id/team", () => {
  it("replaces the team: 200 with the Project, live names and the new ETag (AC-1.5, AC-1.6)", async () => {
    const project = await seed();
    await db.projectMember.create({ data: { projectId: project.id, userId: "user-viewer" } });

    const res = await putTeam(project.id, ["user-colleague", "user-accounting"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"2"');
    expect(res.json).toMatchObject({ id: project.id, version: 2 });
    expect(res.json.team).toHaveLength(2);
    expect(res.json.team).toEqual(expect.arrayContaining([person("user-colleague"), person("user-accounting")]));
    // The old member is gone: the team is what the request says, not a union.
    expect(await memberIdsOf(project.id)).toEqual(["user-accounting", "user-colleague"]);
    expect((await db.project.findUniqueOrThrow({ where: { id: project.id } })).version).toBe(2);
  });

  it("keeps the order people joined in, and leaves a retained member's join date alone", async () => {
    const project = await seed();
    await putTeam(project.id, ["user-viewer"]);
    const before = await db.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId: project.id, userId: "user-viewer" } },
    });
    const res = await putTeam(project.id, ["user-colleague", "user-viewer"], "pmCh", 2);
    expect(res.status).toBe(200);
    expect(res.json.team.map((p: { id: string }) => p.id)).toEqual(["user-viewer", "user-colleague"]);
    const after = await db.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId: project.id, userId: "user-viewer" } },
    });
    expect(after.addedAt).toEqual(before.addedAt);
  });

  it("empties the team with an empty list, and collapses a repeated id", async () => {
    const project = await seed();
    await db.projectMember.create({ data: { projectId: project.id, userId: "user-viewer" } });
    const dup = await putTeam(project.id, ["user-colleague", "user-colleague"]);
    expect(dup.status).toBe(200);
    expect(dup.json.team).toEqual([person("user-colleague")]);
    const empty = await putTeam(project.id, [], "pmCh", 2);
    expect(empty.status).toBe(200);
    expect(empty.json.team).toEqual([]);
    expect(await memberIdsOf(project.id)).toEqual([]);
  });

  it("refuses members without module access: 422 `not_project_user` naming every one, and changes nothing (AC-1.6)", async () => {
    const project = await seed();
    await db.projectMember.create({ data: { projectId: project.id, userId: "user-viewer" } });
    const res = await putTeam(project.id, ["user-colleague", "user-employee", "user-intern"]);
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ status: 422, code: "not_project_user", userIds: ["user-employee", "user-intern"] });
    expect(await memberIdsOf(project.id)).toEqual(["user-viewer"]);
    expect(await db.project.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({ version: 1 });
  });

  it("checks access live: a colleague whose access was revoked since the token was issued is refused (AC-1.6)", async () => {
    const project = await seed();
    appAccess.projects.delete("user-colleague");
    const res = await putTeam(project.id, ["user-colleague"]);
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ code: "not_project_user", userIds: ["user-colleague"] });
  });

  it("does not re-check a member who stays, so a team edit survives one member losing access (AC-1.6)", async () => {
    const project = await seed();
    await db.projectMember.create({ data: { projectId: project.id, userId: "user-colleague" } });
    appAccess.projects.delete("user-colleague");
    // They stay while someone else joins ...
    expect((await putTeam(project.id, ["user-colleague", "user-viewer"])).status).toBe(200);
    // ... and can be taken off.
    expect((await putTeam(project.id, ["user-viewer"], "pmCh", 2)).status).toBe(200);
    expect(await memberIdsOf(project.id)).toEqual(["user-viewer"]);
  });

  it("is 503 `identity_unavailable` when auth cannot say whether someone has access, never an allow (AC-1.6)", async () => {
    const project = await seed();
    identities.down = true;
    const res = await putTeam(project.id, ["user-colleague"]);
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ status: 503, code: "identity_unavailable" });
    expect(await memberIdsOf(project.id)).toEqual([]);
    expect((await db.project.findUniqueOrThrow({ where: { id: project.id } })).version).toBe(1);
  });

  it("needs no identity check for the caller or for taking people off, even with auth down", async () => {
    const project = await seed();
    await db.projectMember.create({ data: { projectId: project.id, userId: "user-viewer" } });
    identities.down = true;
    const res = await putTeam(project.id, ["user-pm-ch"]);
    expect(res.status).toBe(200);
    // Names are fail-soft: unknown while auth cannot answer.
    expect(res.json.team).toEqual([{ id: "user-pm-ch", name: null, deleted: false }]);
    expect((await putTeam(project.id, [], "pmCh", 2)).status).toBe(200);
  });

  it("is 404 for an unknown project", async () => {
    expect((await putTeam("nope", [])).status).toBe(404);
  });

  it.each(["viewer", "accounting"] as const)("refuses %s, who manages nothing: 403 `forbidden`, even with a bad body (AC-4.4)", async (as) => {
    const project = await seed();
    const res = await putTeam(project.id, ["user-colleague"], as);
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "forbidden" });
    expect((await putTeam(project.id, "not a list", as)).status).toBe(403);
    expect(await memberIdsOf(project.id)).toEqual([]);
  });

  it("refuses no module access (403) and no token (401), and a manager of the other entity: 403 `out_of_scope`", async () => {
    const project = await seed({ entity: "welld_it" });
    expect((await putTeam(project.id, [], "outsider")).status).toBe(403);
    expect((await putTeam(project.id, [], null)).status).toBe(401);
    const res = await putTeam(project.id, ["user-colleague"], "pmCh");
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "out_of_scope" });
    expect(await memberIdsOf(project.id)).toEqual([]);
    expect((await putTeam(project.id, ["user-colleague"], "salesIt")).status).toBe(200);
  });

  it.each([
    ["no list", {}],
    ["something that is not a list", { memberIds: "user-colleague" }],
    ["an empty id", { memberIds: [""] }],
    ["an id over 64 characters", { memberIds: ["u".repeat(65)] }],
    ["more than 100 members", { memberIds: Array.from({ length: 101 }, (_, i) => `user-${i}`) }],
    ["an extra member", { memberIds: [], projectManagerId: "user-viewer" }],
  ])("is 400 `validation_failed` for %s", async (_label, body) => {
    const project = await seed();
    const res = await call("PUT", `/projects/${project.id}/team`, { as: "pmCh", body, ifMatch: 1 });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ status: 400, code: "validation_failed" });
  });

  it("needs an If-Match (428) and refuses a stale one (409 `version_conflict`), changing nothing (AC-1.7)", async () => {
    const project = await seed({ version: 3 });
    const missing = await call("PUT", `/projects/${project.id}/team`, { as: "pmCh", body: { memberIds: ["user-colleague"] } });
    expect(missing.status).toBe(428);
    expect(missing.json).toMatchObject({ code: "precondition_required" });
    const stale = await putTeam(project.id, ["user-colleague"], "pmCh", 2);
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: "version_conflict", currentVersion: 3 });
    expect(await memberIdsOf(project.id)).toEqual([]);
    expect((await db.project.findUniqueOrThrow({ where: { id: project.id } })).version).toBe(3);
  });

  it("lets only one of two saves of the same version win, and the loser leaves the team alone (AC-1.7)", async () => {
    const project = await seed();
    const [a, b] = await Promise.all([putTeam(project.id, ["user-colleague"]), putTeam(project.id, ["user-viewer"])]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? "user-colleague" : "user-viewer";
    expect(await memberIdsOf(project.id)).toEqual([winner]);
    expect((await db.project.findUniqueOrThrow({ where: { id: project.id } })).version).toBe(2);
  });

  describe("names are live (AC-1.5)", () => {
    const renamed = new Map<string, string>();
    const worldFetch = globalThis.fetch;
    beforeAll(() => {
      // Wraps the world's auth fake: a renamed user is answered with their new name.
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        const res = await worldFetch(url as string, init);
        if (!String(url).endsWith("/authz/users/identities") || renamed.size === 0) return res;
        const body = (await res.json()) as { users: { id: string; name: string | null }[] };
        return Response.json({ users: body.users.map((u) => (renamed.has(u.id) ? { ...u, name: renamed.get(u.id)! } : u)) });
      }) as typeof fetch;
    });
    afterAll(() => {
      globalThis.fetch = worldFetch;
      renamed.clear();
    });

    it("a renamed user shows the new name on the project, not the one they had when they joined", async () => {
      const project = await seed();
      const put = await putTeam(project.id, ["user-colleague"]);
      expect(put.json.team).toEqual([person("user-colleague")]);

      renamed.set("user-colleague", "Giulia Rossi");
      forgetIdentities(); // names are cached for 60 s
      const read = await call("GET", `/projects/${project.id}`, { as: "viewer" });
      expect(read.json.team).toEqual([{ id: "user-colleague", name: "Giulia Rossi", deleted: false }]);
    });
  });
});
