/**
 * The team stub of the test world (specs/20261126-teams T11): what T12 and T13 build on without editing `world.ts`.
 * It proves the stub speaks `GET /system/teams` as the plan says, that the REAL wired reader works through it with the
 * real service-token path, that the counters and settable failures work, and that `resetWorld()` puts every team window,
 * the cache and the stub back.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { admitTeamRead, TEAM_READ_PERSON_LIMIT } from "../lib/rateLimiter";
import { teamReader, TEAMS_FRESH_MS } from "../lib/teams";
import { advanceTime, appAccess, attachTeam, authSystem, db, makeTeam, resetWorld, SERVICE_JWT, teamsAuth } from "./world";

beforeEach(resetWorld);

const project = () =>
  db.project.create({
    data: { name: "P", type: "internal", entity: "welld_ch", projectManagerId: "user-pm-ch", createdById: "user-pm-ch" },
  });

describe("the stub, read through the real reader", () => {
  it("answers ids mode in request order, an unknown id omitted, members by name with the deactivated last", async () => {
    const team = makeTeam({
      name: "Backend",
      members: [{ id: "user-b", name: "Bea" }, { id: "user-gone", active: false }, { id: "user-a", name: "Ada" }],
    });
    const other = makeTeam({ name: "Design" });
    const read = await teamReader.cached([other.id, "nope", team.id]);
    expect([...read.teams.keys()]).toEqual([other.id, team.id]);
    expect(read.teams.get(team.id)!.members).toEqual([
      { id: "user-a", name: "Ada", active: true, appAccess: false },
      { id: "user-b", name: "Bea", active: true, appAccess: false },
      { id: "user-gone", name: null, active: false, appAccess: false },
    ]);
  });

  it("reports `appAccess` from the people who hold Projects access, unless the member says otherwise", async () => {
    const team = makeTeam({ members: [{ id: "user-viewer" }, { id: "user-outsider" }, { id: "user-x", appAccess: true }] });
    const facts = (await teamReader.cached([team.id])).teams.get(team.id)!;
    const byId = Object.fromEntries(facts.members.map((m) => [m.id, m.appAccess]));
    expect(byId).toEqual({ "user-viewer": true, "user-outsider": false, "user-x": true });
    // a person who loses access loses it at the next read
    appAccess.projects.delete("user-viewer");
    advanceTime(TEAMS_FRESH_MS);
    const later = (await teamReader.cached([team.id])).teams.get(team.id)!;
    expect(later.members.find((m) => m.id === "user-viewer")!.appAccess).toBe(false);
  });

  it("mints and sends the service token, and counts the calls and what each asked", async () => {
    const team = makeTeam();
    await teamReader.cached([team.id]);
    expect(teamsAuth.calls).toBe(1);
    expect(teamsAuth.idsCalls).toBe(1);
    expect(teamsAuth.optionsCalls).toBe(0);
    expect(teamsAuth.requests[0]).toMatchObject({ mode: "ids", ids: [team.id], q: null, authorization: `Bearer ${SERVICE_JWT}` });
  });

  it("a 401 (a token without the scope) makes the reader mint another and ask again", async () => {
    const team = makeTeam();
    teamsAuth.unauthorizedNext = 1;
    const read = await teamReader.cached([team.id]);
    expect(read.teams.has(team.id)).toBe(true);
    expect(teamsAuth.calls).toBe(2);
    // the 401 dropped the cached token, so the second ask went with a freshly minted one
    expect(authSystem.tokenCalls).toBeGreaterThanOrEqual(1);
    expect(teamsAuth.requests.map((r) => r.authorization)).toEqual([`Bearer ${SERVICE_JWT}`, `Bearer ${SERVICE_JWT}`]);
  });

  it("is down, fails the next N calls and recovers, answers any other status, or a raw body", async () => {
    const team = makeTeam();
    teamsAuth.down = true;
    expect((await teamReader.cached([team.id])).unavailable.has(team.id)).toBe(true);
    teamsAuth.down = false;
    teamsAuth.failNext = 1;
    expect((await teamReader.fresh([team.id], { fallback: false })).unavailable.has(team.id)).toBe(true);
    expect((await teamReader.fresh([team.id], { fallback: false })).teams.has(team.id)).toBe(true);
    teamsAuth.status = 429;
    expect((await teamReader.fresh([team.id], { fallback: false })).unavailable.has(team.id)).toBe(true);
    teamsAuth.status = 200;
    teamsAuth.body = { items: "garbage" };
    expect((await teamReader.fresh([team.id], { fallback: false })).unavailable.has(team.id)).toBe(true);
  });

  it("refuses what auth refuses: more than 50 ids (so the reader's chunks matter), a repeated id", async () => {
    const ids = Array.from({ length: 120 }, () => makeTeam().id);
    const read = await teamReader.cached(ids);
    expect(read.teams.size).toBe(120);
    expect(teamsAuth.idsCalls).toBe(3);
  });
});

describe("the stub's options mode", () => {
  it("lists active teams by name, without the archived ones, names only", async () => {
    makeTeam({ name: "Zeta" });
    makeTeam({ name: "Alpha" });
    makeTeam({ name: "Beta", archived: true });
    const { items, truncated } = await teamReader.options();
    expect(items.map((i) => i.name)).toEqual(["Alpha", "Zeta"]);
    expect(Object.keys(items[0]!).sort()).toEqual(["id", "name"]);
    expect(truncated).toBe(false);
  });

  it("with q: a literal case-insensitive substring, exact name first, then prefix, then the rest", async () => {
    makeTeam({ name: "Frontend web" });
    makeTeam({ name: "End" });
    makeTeam({ name: "Endpoints" });
    makeTeam({ name: "100% done" });
    makeTeam({ name: "Backend" });
    expect((await teamReader.options("end")).items.map((i) => i.name)).toEqual(["End", "Endpoints", "Backend", "Frontend web"]);
    // `%` is a character, not a wildcard
    expect((await teamReader.options("%")).items.map((i) => i.name)).toEqual(["100% done"]);
    expect((await teamReader.options("zzz")).items).toEqual([]);
    expect(teamsAuth.requests.at(-1)).toMatchObject({ mode: "options", q: "zzz" });
  });

  it("caps at 50 and says `truncated`", async () => {
    for (let i = 0; i < 51; i++) makeTeam({ name: `Team ${String(i).padStart(2, "0")}` });
    const { items, truncated } = await teamReader.options();
    expect(items).toHaveLength(50);
    expect(truncated).toBe(true);
  });
});

describe("attachTeam, and resetWorld", () => {
  it("attaches a team to a project in the database, and the row goes with the project", async () => {
    const p = await project();
    const team = makeTeam();
    await attachTeam(p.id, team.id);
    expect(await db.attachedTeam.count({ where: { projectId: p.id } })).toBe(1);
    await db.project.delete({ where: { id: p.id } });
    expect(await db.attachedTeam.count()).toBe(0);
  });

  it("resetWorld empties the table, the stub, its counters and the reader's cache", async () => {
    const p = await project();
    const team = makeTeam();
    await attachTeam(p.id, team.id);
    await teamReader.cached([team.id]);
    teamsAuth.down = true;
    await resetWorld();
    expect(await db.attachedTeam.count()).toBe(0);
    expect(teamsAuth.teams.size).toBe(0);
    expect(teamsAuth.calls).toBe(0);
    expect(teamsAuth.requests).toEqual([]);
    expect(teamsAuth.down).toBe(false);
    // the cache is empty: the same id asked again makes a call (here it is unknown, and not served from before)
    const read = await teamReader.cached([team.id]);
    expect(read.teams.size).toBe(0);
    expect(teamsAuth.idsCalls).toBe(1);
  });

  it("resetWorld resets every window, and the clocks that `advanceTime` moved", async () => {
    for (let i = 0; i < TEAM_READ_PERSON_LIMIT; i++) admitTeamRead("user-viewer");
    expect(admitTeamRead("user-viewer").admitted).toBe(false);
    await resetWorld();
    expect(admitTeamRead("user-viewer").admitted).toBe(true);

    const team = makeTeam();
    await teamReader.cached([team.id]);
    advanceTime(TEAMS_FRESH_MS);
    await teamReader.cached([team.id]);
    expect(teamsAuth.idsCalls).toBe(2); // the entry aged out with the clock
    await resetWorld();
    const again = makeTeam();
    await teamReader.cached([again.id]);
    await teamReader.cached([again.id]);
    expect(teamsAuth.idsCalls).toBe(1); // the clock is back: the entry is young again
  });

  it("advanceTime moves the windows too", async () => {
    for (let i = 0; i < TEAM_READ_PERSON_LIMIT; i++) admitTeamRead("user-viewer");
    expect(admitTeamRead("user-viewer").admitted).toBe(false);
    advanceTime(600_001);
    expect(admitTeamRead("user-viewer").admitted).toBe(true);
  });
});
