/**
 * The project page's fresh team read is limited per person and in total (specs/20261126-teams T12; AC-5.6, D15).
 * The decisions' resolves (hours, tasks, meetings) never consult these windows: their tests are in the host files.
 */
import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { advanceTime, attachTeam, call, db, makeTeam, resetWorld, teamsAuth, type PersonaName } from "../test-support/world";
import { TEAM_READ_PERSON_LIMIT, TEAM_READ_SERVICE_LIMIT, teamReadServiceLimiter } from "../lib/rateLimiter";

beforeEach(resetWorld);

const seed = () =>
  db.project.create({
    data: { name: "Koordy", type: "internal", entity: "welld_ch", projectManagerId: "user-pm-ch", createdById: "user-pm-ch" },
  });
const view = (id: string, as: PersonaName) => call("GET", `/projects/${id}`, { as });
const idsOf = (people: { id: string }[]) => people.map((p) => p.id);

/** A project with one attached team "Backend" holding a counted member, and a listed member. */
async function withTeam() {
  const project = await seed();
  await db.projectMember.create({ data: { projectId: project.id, userId: "user-viewer" } });
  const team = makeTeam({ name: "Backend", members: [{ id: "user-colleague" }] });
  await attachTeam(project.id, team.id);
  return { project, team };
}
const exhaust = async (id: string, as: PersonaName) => {
  for (let i = 0; i < TEAM_READ_PERSON_LIMIT; i++) {
    const res = await view(id, as);
    if (res.json.teamsStatus !== "complete") throw new Error(`read ${i} was limited`);
  }
};
const fillService = () => {
  for (let i = 0; i < TEAM_READ_SERVICE_LIMIT; i++) teamReadServiceLimiter.consume("service");
};

describe("the constants (D15)", () => {
  it("pin 120 per person and 2 400 for the service", () => {
    expect(TEAM_READ_PERSON_LIMIT).toBe(120);
    expect(TEAM_READ_SERVICE_LIMIT).toBe(2400);
  });
});

describe("a person over their limit (AC-5.6)", () => {
  it("120 loads read auth and are complete; the 121st still loads, with every team marked and the wait", async () => {
    const { project, team } = await withTeam();
    await exhaust(project.id, "viewer");
    expect(teamsAuth.idsCalls).toBe(120);

    const res = await view(project.id, "viewer");
    expect(res.status).toBe(200);
    expect(res.json.teams).toEqual([{ id: team.id, name: null, archived: null, members: null }]);
    expect(idsOf(res.json.onProject)).toEqual(["user-pm-ch", "user-viewer"]);
    expect(res.json).toMatchObject({ onProjectComplete: false, teamsStatus: "rate_limited", name: "Koordy", version: 1 });
    expect(res.json.teamsRetryAfterSeconds).toBeGreaterThanOrEqual(599);
    expect(res.json.teamsRetryAfterSeconds).toBeLessThanOrEqual(600);
    expect(res.headers.get("ETag")).toBe('"1"');
    expect(idsOf(res.json.team)).toEqual(["user-viewer"]); // people intact
    expect(teamsAuth.idsCalls).toBe(120); // no call, and no cache entry served although one is fresh
  });

  it("reloading while over changes nothing and the wait does not move; once the oldest read leaves the window the page is complete again", async () => {
    const { project, team } = await withTeam();
    await exhaust(project.id, "viewer");
    advanceTime(100_500);
    const first = await view(project.id, "viewer");
    expect(first.json.teamsRetryAfterSeconds).toBe(500);
    for (let i = 0; i < 5; i++) {
      const again = await view(project.id, "viewer");
      expect(again.json).toMatchObject({ teamsStatus: "rate_limited", teamsRetryAfterSeconds: 500 });
    }
    expect(teamsAuth.idsCalls).toBe(120);

    team.name = "Platform";
    advanceTime(500_000);
    const back = await view(project.id, "viewer");
    expect(back.json.teamsStatus).toBe("complete");
    expect(back.json.teams[0].name).toBe("Platform"); // AC-1.3
    expect(teamsAuth.idsCalls).toBe(121);
  });

  it("does not touch another person: their view of the same project is complete, with one call", async () => {
    const { project } = await withTeam();
    await exhaust(project.id, "viewer");
    const calls = teamsAuth.idsCalls;
    const other = await view(project.id, "colleague");
    expect(other.json).toMatchObject({ teamsStatus: "complete", onProjectComplete: true, teamsRetryAfterSeconds: null });
    expect(other.json.teams[0].name).toBe("Backend");
    expect(teamsAuth.idsCalls).toBe(calls + 1);
  });

  it("a project with no team is never limited and counts nothing", async () => {
    const { project } = await withTeam();
    const bare = await seed();
    await exhaust(project.id, "viewer");
    const res = await view(bare.id, "viewer");
    expect(res.json).toMatchObject({ teams: [], teamsStatus: "complete", teamsRetryAfterSeconds: null });
    for (let i = 0; i < 130; i++) await view(bare.id, "colleague");
    expect((await view(project.id, "colleague")).json.teamsStatus).toBe("complete");
  });

  it("logs the first refusal of a person once, with the actor and no project, team or name", async () => {
    const { project, team } = await withTeam();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await exhaust(project.id, "viewer");
      for (let i = 0; i < 4; i++) await view(project.id, "viewer");
      const lines = warn.mock.calls.map((args) => args.join(" ")).filter((line) => line.includes("page-read limited"));
      expect(lines).toEqual(["[teams] page-read limited actor=user-viewer window=person"]);
      expect(lines[0]).not.toContain(project.id);
      expect(lines[0]).not.toContain(team.id);
      expect(lines[0]).not.toContain("Backend");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("writes with the person over their limit", () => {
  it("PATCH commits and answers the degraded view", async () => {
    const { project } = await withTeam();
    await exhaust(project.id, "pmCh");
    const res = await call("PATCH", `/projects/${project.id}`, { as: "pmCh", body: { name: "Renamed" }, ifMatch: 1 });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ name: "Renamed", version: 2, teamsStatus: "rate_limited" });
    expect((await db.project.findUniqueOrThrow({ where: { id: project.id } })).name).toBe("Renamed");
  });

  it("PUT …/teams adding a team is 429 rate_limited with retryAfterSeconds equal to Retry-After, and writes nothing", async () => {
    const { project, team } = await withTeam();
    const added = makeTeam();
    await exhaust(project.id, "pmCh");
    const res = await call("PUT", `/projects/${project.id}/teams`, { as: "pmCh", body: { teamIds: [team.id, added.id] }, ifMatch: 1 });
    expect(res.status).toBe(429);
    expect(res.json).toMatchObject({ status: 429, code: "rate_limited", instance: `/projects/${project.id}/teams` });
    expect(res.json.retryAfterSeconds).toBe(Number(res.headers.get("Retry-After")));
    expect(res.json.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(res.json.retryAfterSeconds).toBeLessThanOrEqual(600);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await db.attachedTeam.count({ where: { projectId: project.id } })).toBe(1);
    expect((await db.project.findUniqueOrThrow({ where: { id: project.id } })).version).toBe(1);
  });

  it("PUT …/teams only removing commits and answers the degraded view", async () => {
    const { project, team } = await withTeam();
    const second = makeTeam();
    await attachTeam(project.id, second.id);
    await exhaust(project.id, "pmCh");
    const res = await call("PUT", `/projects/${project.id}/teams`, { as: "pmCh", body: { teamIds: [team.id] }, ifMatch: 1 });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ version: 2, teamsStatus: "rate_limited" });
    expect(res.json.teams).toEqual([{ id: team.id, name: null, archived: null, members: null }]);
  });
});

describe("what counts, and where (D15)", () => {
  it("a refused request (403, 404, 409, 428) counts nothing; a PUT …/teams costs one call and one count", async () => {
    const { project, team } = await withTeam();
    for (let i = 0; i < 5; i++) {
      expect((await call("PATCH", `/projects/${project.id}`, { as: "viewer", body: { name: "X" }, ifMatch: 1 })).status).toBe(403);
      expect((await call("GET", "/projects/unknown", { as: "pmCh" })).status).toBe(404);
      expect((await call("PUT", `/projects/${project.id}/teams`, { as: "pmCh", body: { teamIds: [team.id] }, ifMatch: 9 })).status).toBe(409);
      expect((await call("PUT", `/projects/${project.id}/teams`, { as: "pmCh", body: { teamIds: [team.id] } })).status).toBe(428);
      expect((await call("GET", `/projects/${project.id}`, { as: "outsider" })).status).toBe(403);
    }
    expect(teamsAuth.calls).toBe(0);

    const put = await call("PUT", `/projects/${project.id}/teams`, { as: "pmCh", body: { teamIds: [team.id] }, ifMatch: 1 });
    expect(put.status).toBe(200);
    expect(teamsAuth.idsCalls).toBe(1);
    for (let i = 0; i < 119; i++) expect((await view(project.id, "pmCh")).json.teamsStatus).toBe("complete");
    expect((await view(project.id, "pmCh")).json.teamsStatus).toBe("rate_limited");
  });
});

describe("the service window (D15)", () => {
  it("once it is full a person under their own limit gets `unavailable`, not `rate_limited`", async () => {
    const { project, team } = await withTeam();
    fillService();
    const res = await view(project.id, "viewer");
    expect(res.status).toBe(200);
    expect(res.json.teams).toEqual([{ id: team.id, name: null, archived: null, members: null }]);
    expect(res.json).toMatchObject({ onProjectComplete: false, teamsStatus: "unavailable", teamsRetryAfterSeconds: null });
    expect(teamsAuth.calls).toBe(0);
  });

  it("a PUT …/teams adding a team is 503 teams_unavailable; only removing commits", async () => {
    const { project, team } = await withTeam();
    const added = makeTeam();
    fillService();
    const adding = await call("PUT", `/projects/${project.id}/teams`, { as: "pmCh", body: { teamIds: [team.id, added.id] }, ifMatch: 1 });
    expect(adding.status).toBe(503);
    expect(adding.json.code).toBe("teams_unavailable");
    const removing = await call("PUT", `/projects/${project.id}/teams`, { as: "pmCh", body: { teamIds: [] }, ifMatch: 1 });
    expect(removing.status).toBe(200);
  });

  it("a refused read spends nothing in either window", async () => {
    const { project } = await withTeam();
    fillService();
    for (let i = 0; i < 130; i++) await view(project.id, "viewer");
    advanceTime(600_001);
    expect((await view(project.id, "viewer")).json.teamsStatus).toBe("complete");
  });
});
