/**
 * The meeting-host resolve projects-api serves to meetings-api (specs/20261104-meetings A18, US-11). Runs the
 * ASSEMBLED app against the `*_test` database.
 */
import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { teamReadPersonLimiter, teamReadServiceLimiter } from "../lib/rateLimiter";
import { HOST_AUTHZ_WAIT_MS, HOST_PATH_REST_MS } from "../lib/hostBudget";
import { advanceTime, attachTeam, authzFake, installAuthzFake, call, db, makeTeam, resetWorld, teamsAuth, type PersonaName } from "../test-support/world";

beforeEach(resetWorld);

const seed = () =>
  db.project.create({
    data: { name: "Koordy", type: "internal", entity: "welld_ch", projectManagerId: "user-pm-ch", createdById: "user-pm-ch" },
  });

const resolve = (ids: string[], as: PersonaName | null = "viewer", entityType = "project") =>
  call("POST", "/meeting-host/v1/resolve", { as, body: { entityType, ids } });

describe("POST /meeting-host/v1/resolve", () => {
  it("is 401 without a token, 400 for another entity type or no id", async () => {
    expect((await resolve(["x"], null)).status).toBe(401);
    expect((await resolve(["x"], "viewer", "deal")).status).toBe(400);
    expect((await resolve([], "viewer")).status).toBe(400);
  });

  it("describes a project to a reader: title and page; a team member is a host reader, anyone else is not", async () => {
    const project = await seed();
    await db.projectMember.create({ data: { projectId: project.id, userId: "user-colleague" } });
    const open = { id: project.id, state: "open", title: "Koordy", href: `/projects/${project.id}` };

    const viewer = await resolve([project.id], "viewer");
    expect(viewer.status).toBe(200);
    expect(viewer.headers.get("cache-control")).toBe("no-store");
    expect(viewer.json.items).toEqual([{ ...open, hostVisible: false }]);
    expect((await resolve([project.id], "colleague")).json.items).toEqual([{ ...open, hostVisible: true }]);
    expect((await resolve([project.id], "pmCh")).json.items).toEqual([{ ...open, hostVisible: true }]);
    // An admin is not on the team: no role overrides the team rule.
    expect((await resolve([project.id], "admin")).json.items).toEqual([{ ...open, hostVisible: false }]);
  });

  it("answers missing for an unknown project and closed to a caller without projects:access, once per id", async () => {
    const project = await seed();
    const res = await resolve([project.id, "nope", project.id], "outsider");
    expect(res.json.items).toEqual([
      { id: project.id, state: "closed" },
      { id: "nope", state: "missing" },
    ]);
  });
});

// ─── Teams (specs/20261126-teams T13: AC-5.3, AC-5.4, AC-5.6) ────────────────────────────────────────────────────────

describe("POST /meeting-host/v1/resolve — attached teams", () => {
  it("makes a team-only reader a host reader, and not once they leave (AC-5.3)", async () => {
    const project = await seed();
    const team = makeTeam({ members: [{ id: "user-colleague" }] });
    await attachTeam(project.id, team.id);
    const open = { id: project.id, state: "open", title: "Koordy", href: `/projects/${project.id}` };
    expect((await resolve([project.id], "colleague")).json.items).toEqual([{ ...open, hostVisible: true }]);
    expect((await resolve([project.id], "viewer")).json.items).toEqual([{ ...open, hostVisible: false }]);

    team.members = [];
    advanceTime(31_000); // past the 30 s of freshness: the next decision reads the team again
    expect((await resolve([project.id], "colleague")).json.items).toEqual([{ ...open, hostVisible: false }]);
  });

  it("answers closed to a team member without Projects access, and asks nothing (AC-5.3, AC-4.7)", async () => {
    const project = await seed();
    await attachTeam(project.id, makeTeam({ members: [{ id: "user-outsider" }] }).id);
    expect((await resolve([project.id], "outsider")).json.items).toEqual([{ id: project.id, state: "closed" }]);
    expect(teamsAuth.calls).toBe(0);
  });

  it("does not count a deactivated member, and counts an archived team (AC-4.7)", async () => {
    const project = await seed();
    await attachTeam(project.id, makeTeam({ archived: true, members: [{ id: "user-colleague" }, { id: "user-viewer", active: false }] }).id);
    expect((await resolve([project.id], "colleague")).json.items[0].hostVisible).toBe(true);
    expect((await resolve([project.id], "viewer")).json.items[0].hostVisible).toBe(false);
  });

  it("answers 503 teams_unavailable, never false, when the caller is not listed and a team's members are unknown (AC-5.4, D3)", async () => {
    const project = await seed();
    await attachTeam(project.id, makeTeam({ members: [{ id: "user-colleague" }] }).id);
    teamsAuth.down = true;
    const res = await resolve([project.id], "colleague");
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("teams_unavailable");
    // a team that auth does not know is unknown too
    teamsAuth.down = false;
    const other = await seed();
    await attachTeam(other.id, "team-unknown-to-auth");
    expect((await resolve([other.id], "viewer")).status).toBe(503);
  });

  it("answers the project manager and a listed member without a team read, even while auth fails (AC-5.4)", async () => {
    const project = await seed();
    await db.projectMember.create({ data: { projectId: project.id, userId: "user-colleague" } });
    await attachTeam(project.id, makeTeam({ members: [{ id: "user-viewer" }] }).id);
    teamsAuth.down = true;
    expect((await resolve([project.id], "pmCh")).json.items[0].hostVisible).toBe(true);
    expect((await resolve([project.id], "colleague")).json.items[0].hostVisible).toBe(true);
    expect(teamsAuth.calls).toBe(0);
  });

  it("asks nothing about a project without a team, a missing one or a closed one, while auth fails", async () => {
    const plain = await seed();
    const withTeam = await seed();
    await attachTeam(withTeam.id, makeTeam({ members: [{ id: "user-colleague" }] }).id);
    teamsAuth.down = true;
    expect((await resolve([plain.id, "nope"], "viewer")).json.items).toEqual([
      { id: plain.id, state: "open", title: "Koordy", href: `/projects/${plain.id}`, hostVisible: false },
      { id: "nope", state: "missing" },
    ]);
    expect((await resolve([withTeam.id], "outsider")).json.items).toEqual([{ id: withTeam.id, state: "closed" }]);
    expect(teamsAuth.calls).toBe(0);
  });

  it("is still true when the caller is on a readable team although another attached team is unknown (a positive needs no more)", async () => {
    const project = await seed();
    await attachTeam(project.id, makeTeam({ members: [{ id: "user-colleague" }] }).id);
    await attachTeam(project.id, "team-unknown-to-auth");
    expect((await resolve([project.id], "colleague")).json.items[0].hostVisible).toBe(true);
    expect((await resolve([project.id], "viewer")).status).toBe(503);
  });

  it("never consults the page-read windows, even for a caller over their limit (AC-5.6)", async () => {
    const project = await seed();
    await attachTeam(project.id, makeTeam({ members: [{ id: "user-colleague" }] }).id);
    for (let i = 0; i < 120; i++) teamReadPersonLimiter.consume("user-colleague");
    const spies = [
      spyOn(teamReadPersonLimiter, "peek"),
      spyOn(teamReadPersonLimiter, "consume"),
      spyOn(teamReadServiceLimiter, "peek"),
      spyOn(teamReadServiceLimiter, "consume"),
    ];
    try {
      expect((await resolve([project.id], "colleague")).json.items[0].hostVisible).toBe(true);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("POST /meeting-host/v1/resolve under a slow permission check (R13 a)", () => {
  it("answers 503 authz_unavailable within the permission wait plus the rest while auth holds /authz/resolve, then answers normally once it has", async () => {
    installAuthzFake(); // the harness's resolve is process-wide and other files swap it
    const project = await seed();
    let release!: () => void;
    authzFake.hold = new Promise<void>((done) => {
      release = done;
    });
    try {
      const started = Date.now();
      const res = await resolve([project.id]);
      expect(res.status).toBe(503);
      expect(res.json.code).toBe("authz_unavailable");
      expect(Date.now() - started).toBeLessThan(HOST_AUTHZ_WAIT_MS + HOST_PATH_REST_MS);
      expect(authzFake.calls).toBe(1);
    } finally {
      release();
    }
    await new Promise<void>((done) => setTimeout(done, 30)); // the flight, not aborted, fills the cache
    const retry = await resolve([project.id]);
    expect(retry.status).toBe(200);
    expect(retry.json.items[0].state).toBe("open");
    expect(authzFake.calls).toBe(1);
  });
});
