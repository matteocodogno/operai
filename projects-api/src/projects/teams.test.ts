/**
 * Teams on a project (specs/20261126-teams T12; AC-1.3, AC-1.5, AC-4.1 – AC-4.3, AC-4.7, AC-4.9, AC-5.4, AC-5.5):
 * the project view's `teams` / `onProject` fields, `PUT /projects/{id}/teams` and `GET /attachable-teams`. Runs the
 * ASSEMBLED app against the `*_test` database; auth's team read is the fake of test-support/world.ts. The per-person
 * page limit (AC-5.6) is in teams.pageLimit.test.ts.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import {
  advanceTime,
  appAccess,
  attachTeam,
  call,
  db,
  makeTeam,
  resetWorld,
  teamsAuth,
  type PersonaName,
} from "../test-support/world";
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

const view = (id: string, as: PersonaName = "viewer") => call("GET", `/projects/${id}`, { as });
const putTeams = (id: string, teamIds: unknown, as: PersonaName | null = "pmCh", ifMatch: number | string = 1) =>
  call("PUT", `/projects/${id}/teams`, { as, body: { teamIds }, ifMatch });
const attachedIds = async (projectId: string) =>
  (await db.attachedTeam.findMany({ where: { projectId }, orderBy: [{ attachedAt: "asc" }, { teamId: "asc" }] })).map((t) => t.teamId);
const versionOf = async (id: string) => (await db.project.findUniqueOrThrow({ where: { id } })).version;
const person = (id: string) => ({ id, name: `Name of ${id}`, deleted: false });
const idsOf = (people: { id: string }[]) => people.map((p) => p.id);

describe("the project view's teams", () => {
  it("a project with no team reads nothing: `teams: []`, the manager and listed members, complete", async () => {
    const project = await seed();
    await db.projectMember.create({ data: { projectId: project.id, userId: "user-viewer" } });
    const res = await view(project.id);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      teams: [],
      onProject: [person("user-pm-ch"), person("user-viewer")],
      onProjectComplete: true,
      teamsStatus: "complete",
      teamsRetryAfterSeconds: null,
    });
    expect(teamsAuth.calls).toBe(0);
  });

  it("shows each attached team by its live name, in attach order; a rename shows on the NEXT load (AC-1.3)", async () => {
    const project = await seed();
    const a = makeTeam({ name: "Backend", members: [{ id: "user-colleague" }] });
    const b = makeTeam({ name: "Design" });
    await attachTeam(project.id, a.id);
    await attachTeam(project.id, b.id);

    const first = await view(project.id);
    expect(first.json.teams.map((t: { id: string; name: string }) => [t.id, t.name])).toEqual([
      [a.id, "Backend"],
      [b.id, "Design"],
    ]);
    expect(first.json.teams[0]).toEqual({
      id: a.id,
      name: "Backend",
      archived: false,
      members: [{ id: "user-colleague", name: "Name of user-colleague", deleted: false, projectsAccess: true }],
    });
    a.name = "Platform";
    const second = await view(project.id);
    expect(second.json.teams[0].name).toBe("Platform");
    expect(teamsAuth.idsCalls).toBe(2); // fresh each time, one call for both teams
  });

  it("marks a deactivated member (name null) and a member without Projects access, and counts neither (AC-4.3, AC-4.7)", async () => {
    const project = await seed();
    const team = makeTeam({
      name: "Backend",
      members: [{ id: "user-colleague" }, { id: "user-gone", active: false }, { id: "user-employee", name: "Eve", appAccess: false }],
    });
    await attachTeam(project.id, team.id);
    const res = await view(project.id, "viewer"); // a reader without project:manage sees the members too
    expect(res.status).toBe(200);
    expect(res.json.teams[0].members).toEqual([
      { id: "user-employee", name: "Eve", deleted: false, projectsAccess: false },
      { id: "user-colleague", name: "Name of user-colleague", deleted: false, projectsAccess: true },
      { id: "user-gone", name: null, deleted: true, projectsAccess: false },
    ]);
    expect(idsOf(res.json.onProject)).toEqual(["user-pm-ch", "user-colleague"]);
    // still attached and accepted; counted from the moment the person gains access
    expect(await attachedIds(project.id)).toEqual([team.id]);
    team.members[2] = { id: "user-employee", name: "Eve", appAccess: true };
    const later = await view(project.id);
    expect(idsOf(later.json.onProject)).toEqual(["user-pm-ch", "user-employee", "user-colleague"]);
  });

  it("counts a person once, in the order manager, listed, team members of each team in attach order (AC-4.4)", async () => {
    const project = await seed();
    await db.projectMember.createMany({
      data: [
        { projectId: project.id, userId: "user-viewer", addedAt: new Date("2026-01-01") },
        { projectId: project.id, userId: "user-accounting", addedAt: new Date("2026-01-02") },
      ],
    });
    appAccess.projects.add("user-sales-it");
    const t1 = makeTeam({ members: [{ id: "user-accounting" }, { id: "user-colleague" }, { id: "user-pm-ch" }] });
    const t2 = makeTeam({ members: [{ id: "user-colleague" }, { id: "user-sales-it" }] });
    await attachTeam(project.id, t1.id);
    await attachTeam(project.id, t2.id);
    const res = await view(project.id);
    expect(idsOf(res.json.onProject)).toEqual(["user-pm-ch", "user-viewer", "user-accounting", "user-colleague", "user-sales-it"]);
    expect(res.json.onProjectComplete).toBe(true);
  });

  it("an archived team still counts and is shown as archived (AC-1.5, O4)", async () => {
    const project = await seed();
    const team = makeTeam({ name: "Old", archived: true, members: [{ id: "user-colleague" }] });
    await attachTeam(project.id, team.id);
    const res = await view(project.id);
    expect(res.json.teams[0]).toMatchObject({ name: "Old", archived: true });
    expect(idsOf(res.json.onProject)).toContain("user-colleague");
    expect(res.json.teamsStatus).toBe("complete");
  });

  it("when auth cannot be read the page still loads: teams marked, members null, only the listed people, `unavailable` (AC-5.4)", async () => {
    const project = await seed();
    await db.projectMember.create({ data: { projectId: project.id, userId: "user-viewer" } });
    const team = makeTeam({ name: "Backend", members: [{ id: "user-colleague" }] });
    await attachTeam(project.id, team.id);
    teamsAuth.down = true;
    const res = await view(project.id);
    expect(res.status).toBe(200);
    expect(res.json.teams).toEqual([{ id: team.id, name: null, archived: null, members: null }]);
    expect(res.json).toMatchObject({
      onProject: [person("user-pm-ch"), person("user-viewer")],
      onProjectComplete: false,
      teamsStatus: "unavailable",
      teamsRetryAfterSeconds: null,
    });
    expect(res.json.team).toEqual([person("user-viewer")]);
  });

  it("falls back to an entry of at most 60 s when the fresh read fails, then keeps only the name it still holds (AC-5.4, D2)", async () => {
    const project = await seed();
    const team = makeTeam({ name: "Backend", members: [{ id: "user-colleague" }] });
    await attachTeam(project.id, team.id);
    expect((await view(project.id)).json.teamsStatus).toBe("complete");
    teamsAuth.down = true;
    advanceTime(40_000);
    const stale = await view(project.id);
    expect(stale.json.teamsStatus).toBe("complete");
    expect(stale.json.teams[0].members).toHaveLength(1);
    advanceTime(30_000); // the entry is now 70 s old
    const old = await view(project.id);
    expect(old.json.teams[0]).toEqual({ id: team.id, name: "Backend", archived: false, members: null });
    expect(old.json).toMatchObject({ onProjectComplete: false, teamsStatus: "unavailable" });
  });

  it("an id auth does not know is a team that could not be loaded", async () => {
    const project = await seed();
    await attachTeam(project.id, "team-gone");
    const res = await view(project.id);
    expect(res.json.teams).toEqual([{ id: "team-gone", name: null, archived: null, members: null }]);
    expect(res.json).toMatchObject({ onProjectComplete: false, teamsStatus: "unavailable" });
  });
});

describe("PUT /projects/:id/teams", () => {
  it("attaches teams: 200, a new ETag, the view shows them in request order, with one auth call (AC-4.1)", async () => {
    const project = await seed();
    const a = makeTeam({ name: "Backend", members: [{ id: "user-colleague" }] });
    const b = makeTeam({ name: "Design" });
    const res = await putTeams(project.id, [b.id, a.id]);
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"2"');
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.json.version).toBe(2);
    expect(res.json.teams.map((t: { name: string }) => t.name)).toEqual(["Design", "Backend"]);
    expect(idsOf(res.json.onProject)).toEqual(["user-pm-ch", "user-colleague"]);
    expect(res.json.teamsStatus).toBe("complete");
    expect(await attachedIds(project.id)).toEqual([b.id, a.id]);
    expect(teamsAuth.idsCalls).toBe(1);
    expect(teamsAuth.requests[0]!.ids).toEqual([b.id, a.id]);
  });

  it("detaches: 200 and a new ETag; a listed person stays, a team-only person leaves (AC-4.5)", async () => {
    const project = await seed();
    await db.projectMember.create({ data: { projectId: project.id, userId: "user-viewer" } });
    const team = makeTeam({ members: [{ id: "user-viewer" }, { id: "user-colleague" }] });
    await attachTeam(project.id, team.id);
    const res = await putTeams(project.id, []);
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"2"');
    expect(res.json.teams).toEqual([]);
    expect(idsOf(res.json.onProject)).toEqual(["user-pm-ch", "user-viewer"]);
    expect(await attachedIds(project.id)).toEqual([]);
    expect(teamsAuth.calls).toBe(0); // an empty set reads nothing
  });

  it("collapses a repeated id and keeps the teams that stay where they are", async () => {
    const project = await seed();
    const a = makeTeam();
    const b = makeTeam();
    await attachTeam(project.id, a.id);
    const res = await putTeams(project.id, [b.id, a.id, b.id]);
    expect(res.status).toBe(200);
    expect(idsOf(res.json.teams)).toEqual([a.id, b.id]);
  });

  it("refuses the other entity (403 out_of_scope), a stale version (409), no precondition (428), more than 10 (400), extra members (400)", async () => {
    const project = await seed();
    const team = makeTeam();
    const other = await putTeams(project.id, [team.id], "salesIt");
    expect(other.status).toBe(403);
    expect(other.json).toMatchObject({ code: "out_of_scope" });
    expect((await putTeams(project.id, [team.id], "pmCh", 7)).status).toBe(409);
    const missing = await call("PUT", `/projects/${project.id}/teams`, { as: "pmCh", body: { teamIds: [team.id] } });
    expect(missing.status).toBe(428);
    const eleven = Array.from({ length: 11 }, (_, i) => `team-x${i}`);
    expect((await putTeams(project.id, eleven)).status).toBe(400);
    const extra = await call("PUT", `/projects/${project.id}/teams`, { as: "pmCh", body: { teamIds: [], memberIds: [] }, ifMatch: 1 });
    expect(extra.status).toBe(400);
    expect((await call("PUT", "/projects/unknown/teams", { as: "pmCh", body: { teamIds: [] }, ifMatch: 1 })).status).toBe(404);
    expect(await attachedIds(project.id)).toEqual([]);
    expect(await versionOf(project.id)).toBe(1);
    expect(teamsAuth.calls).toBe(0);
  });

  it("allows exactly 10 teams", async () => {
    const project = await seed();
    const ids = Array.from({ length: 10 }, () => makeTeam().id);
    const res = await putTeams(project.id, ids);
    expect(res.status).toBe(200);
    expect(res.json.teams).toHaveLength(10);
  });

  it("refuses an archived team being added (422 team_archived) but accepts one already attached (AC-4.2)", async () => {
    const project = await seed();
    const old = makeTeam({ archived: true });
    const fresh = makeTeam();
    const refused = await putTeams(project.id, [old.id, fresh.id]);
    expect(refused.status).toBe(422);
    expect(refused.json).toMatchObject({ code: "team_archived", teamIds: [old.id] });
    expect(await attachedIds(project.id)).toEqual([]);
    expect(await versionOf(project.id)).toBe(1);

    await attachTeam(project.id, old.id);
    const kept = await putTeams(project.id, [old.id, fresh.id]);
    expect(kept.status).toBe(200);
    expect(idsOf(kept.json.teams)).toEqual([old.id, fresh.id]);
  });

  it("refuses an unknown team (422 team_not_found naming it) and writes nothing", async () => {
    const project = await seed();
    const team = makeTeam();
    const res = await putTeams(project.id, [team.id, "team-nope", "bad id!"]);
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ code: "team_not_found", teamIds: ["team-nope", "bad id!"] });
    expect(await attachedIds(project.id)).toEqual([]);
  });

  it("with auth failing: adding is 503 teams_unavailable and writes nothing; only removing commits and answers `unavailable` (AC-5.4)", async () => {
    const project = await seed();
    const kept = makeTeam({ name: "Kept" });
    const gone = makeTeam({ name: "Gone" });
    const added = makeTeam();
    await attachTeam(project.id, kept.id);
    await attachTeam(project.id, gone.id);
    teamsAuth.down = true;
    const adding = await putTeams(project.id, [kept.id, added.id]);
    expect(adding.status).toBe(503);
    expect(adding.json).toMatchObject({ code: "teams_unavailable" });
    expect(await versionOf(project.id)).toBe(1);

    const removing = await putTeams(project.id, [kept.id]);
    expect(removing.status).toBe(200);
    expect(removing.json.version).toBe(2);
    expect(removing.json.teams).toEqual([{ id: kept.id, name: null, archived: null, members: null }]);
    expect(removing.json).toMatchObject({ onProjectComplete: false, teamsStatus: "unavailable", teamsRetryAfterSeconds: null });
    expect(await attachedIds(project.id)).toEqual([kept.id]);
  });

  it("never confirms an added team from a cached copy: with auth down it is 503 although an entry is fresh", async () => {
    const project = await seed();
    const team = makeTeam({ name: "Backend" });
    expect((await putTeams(project.id, [team.id])).status).toBe(200); // fills the cache with a live team
    expect((await putTeams(project.id, [], "pmCh", 2)).status).toBe(200);
    teamsAuth.down = true;
    const again = await putTeams(project.id, [team.id], "pmCh", 3);
    expect(again.status).toBe(503);
    expect(again.json.code).toBe("teams_unavailable");
    expect(await attachedIds(project.id)).toEqual([]);
  });

  it("with nothing to confirm (only removing) a recent entry fills the view when the read fails", async () => {
    const project = await seed();
    const a = makeTeam({ name: "Alpha" });
    const b = makeTeam({ name: "Beta" });
    expect((await putTeams(project.id, [a.id, b.id])).status).toBe(200);
    teamsAuth.down = true;
    const res = await putTeams(project.id, [a.id], "pmCh", 2);
    expect(res.status).toBe(200);
    expect(res.json.teams[0]).toMatchObject({ id: a.id, name: "Alpha", archived: false });
    expect(res.json.teamsStatus).toBe("complete");
  });
});

describe("a team gives presence, never capability (AC-5.5)", () => {
  it("a team-only person holding only projects:access cannot change the project", async () => {
    const project = await seed();
    const team = makeTeam({ members: [{ id: "user-viewer" }] });
    await attachTeam(project.id, team.id);
    const patch = await call("PATCH", `/projects/${project.id}`, { as: "viewer", body: { name: "X" }, ifMatch: 1 });
    const putTeam = await call("PUT", `/projects/${project.id}/team`, { as: "viewer", body: { memberIds: [] }, ifMatch: 1 });
    const put = await putTeams(project.id, [], "viewer");
    for (const res of [patch, putTeam, put]) {
      expect(res.status).toBe(403);
      expect(res.json.code).toBe("forbidden");
    }
    expect(await attachedIds(project.id)).toEqual([team.id]);
  });
});

describe("a project manager stays one person (AC-4.9)", () => {
  it("a team id as the project manager is 422 not_project_user", async () => {
    const project = await seed();
    const team = makeTeam();
    const patch = await call("PATCH", `/projects/${project.id}`, { as: "pmCh", body: { projectManagerId: team.id }, ifMatch: 1 });
    expect(patch.status).toBe(422);
    expect(patch.json.code).toBe("not_project_user");
    const create = await call("POST", "/projects", {
      as: "pmCh",
      body: { name: "N", type: "internal", entity: "welld_ch", projectManagerId: team.id },
    });
    expect(create.status).toBe(422);
    expect(create.json.code).toBe("not_project_user");
    const members = await call("PUT", `/projects/${project.id}/team`, { as: "pmCh", body: { memberIds: [team.id] }, ifMatch: 1 });
    expect(members.status).toBe(422);
    expect(members.json.code).toBe("not_project_user");
  });
});

describe("GET /attachable-teams", () => {
  const search = (q?: string, as: PersonaName | null = "pmCh") =>
    call("GET", `/attachable-teams${q === undefined ? "" : `?q=${encodeURIComponent(q)}`}`, { as });

  it("passes auth's active teams through, fresh, never cached, no-store (AC-1.5)", async () => {
    makeTeam({ name: "Backend" });
    makeTeam({ name: "Old", archived: true });
    const res = await search();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.json).toEqual({ items: [{ id: expect.any(String), name: "Backend" }], truncated: false });
    await search();
    expect(teamsAuth.optionsCalls).toBe(2);
    expect(teamsAuth.requests[0]!.q).toBeNull();
  });

  it("trims q before it reaches auth; a blank q is no search (AC-4.1)", async () => {
    makeTeam({ name: "Backend" });
    await search(" Back ");
    expect(teamsAuth.requests.at(-1)!.q).toBe("Back");
    await search("   ");
    expect(teamsAuth.requests.at(-1)!.q).toBeNull();
    await search("");
    expect(teamsAuth.requests.at(-1)!.q).toBeNull();
    expect(teamsAuth.optionsCalls).toBe(3);
  });

  it("passes `truncated` through", async () => {
    for (let i = 0; i < 51; i++) makeTeam({ name: `Team ${String(i).padStart(2, "0")}` });
    const res = await search();
    expect(res.json.items).toHaveLength(50);
    expect(res.json.truncated).toBe(true);
  });

  it("refuses a q of 81 characters after trimming, 201 raw, or with a NUL: 400 and no auth call", async () => {
    for (const q of ["a".repeat(81), `${"a".repeat(80)}${" ".repeat(121)}`, "a\u0000b"]) {
      const res = await search(q);
      expect({ q: q.length, status: res.status }).toEqual({ q: q.length, status: 400 });
      expect(res.json.code).toBe("validation_failed");
    }
    expect((await search(` ${"a".repeat(80)} `)).status).toBe(200); // 80 after trimming is fine
    expect(teamsAuth.optionsCalls).toBe(1);
  });

  it("is for holders of project:manage: 403 before anything, and no auth call", async () => {
    for (const as of ["viewer", "outsider", "accounting"] as const) {
      expect((await search("back", as)).status).toBe(403);
    }
    expect((await search("back", null)).status).toBe(401);
    expect(teamsAuth.calls).toBe(0);
  });

  it("is 503 teams_unavailable when auth fails, answers 429, or answers something else", async () => {
    makeTeam();
    teamsAuth.down = true;
    expect((await search()).json).toMatchObject({ status: 503, code: "teams_unavailable" });
    teamsAuth.down = false;
    teamsAuth.status = 429;
    expect((await search()).json).toMatchObject({ status: 503, code: "teams_unavailable" });
    teamsAuth.status = 200;
    teamsAuth.body = { items: "nope" };
    expect((await search()).status).toBe(503);
  });

  it("limits each caller to 120 requests per 10 minutes: the 121st is 429 with Retry-After and no auth call", async () => {
    makeTeam();
    for (let i = 0; i < 120; i++) expect((await search()).status).toBe(200);
    const calls = teamsAuth.calls;
    const over = await search();
    expect(over.status).toBe(429);
    expect(over.json).toMatchObject({ status: 429, code: "rate_limited" });
    const wait = Number(over.headers.get("Retry-After"));
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThanOrEqual(600);
    expect(over.json.retryAfterSeconds).toBe(wait);
    expect(teamsAuth.calls).toBe(calls);
    // another caller is unaffected; a refused attempt is not recorded; time heals
    expect((await search(undefined, "admin")).status).toBe(200);
    advanceTime(600_001);
    expect((await search()).status).toBe(200);
  });

  it("counts malformed requests (400) but not those the guard refused (403)", async () => {
    makeTeam();
    for (let i = 0; i < 100; i++) await search("denied", "viewer");
    for (let i = 0; i < 119; i++) expect((await search("a".repeat(81))).status).toBe(400);
    expect((await search()).status).toBe(200); // the 120th counted request
    expect((await search()).status).toBe(429);
  });

  it("is independent of the page-read window", async () => {
    const project = await seed();
    const team = makeTeam();
    await attachTeam(project.id, team.id);
    for (let i = 0; i < 120; i++) await search();
    expect((await search()).status).toBe(429);
    expect((await view(project.id, "pmCh")).json.teamsStatus).toBe("complete");
  });
});
