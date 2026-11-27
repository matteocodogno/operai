/**
 * The team filter of the project list and the teams that feed it (specs/20261126-teams T14; AC-4.8, AC-5.4):
 * `GET /projects?teamId=` and `GET /attached-teams`. The ASSEMBLED app against the `*_test` database; auth's team read is the
 * fake of test-support/world.ts.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { advanceTime, attachTeam, call, db, makeTeam, resetWorld, teamsAuth, type PersonaName } from "../test-support/world";

beforeEach(resetWorld);

const seed = (name: string) =>
  db.project.create({
    data: { name, type: "internal", entity: "welld_ch", projectManagerId: "user-pm-ch", createdById: "user-pm-ch" },
  });

const list = (query: string, as: PersonaName | null = "viewer") => call("GET", `/projects${query}`, { as });
const names = (res: { json: { items: { name: string }[] } }) => res.json.items.map((item) => item.name);
const attached = (as: PersonaName | null = "viewer") => call("GET", "/attached-teams", { as });

describe("GET /projects?teamId=", () => {
  it("lists only the projects that team is attached to, by name, and none of the others", async () => {
    const team = makeTeam({ name: "Backend" });
    const other = makeTeam({ name: "Mobile" });
    const a = await seed("Alpha");
    const b = await seed("Bravo");
    const c = await seed("Charlie");
    await seed("Delta");
    await attachTeam(c.id, team.id);
    await attachTeam(a.id, team.id);
    await attachTeam(b.id, other.id);
    const res = await list(`?teamId=${team.id}`);
    expect(res.status).toBe(200);
    expect(names(res)).toEqual(["Alpha", "Charlie"]);
    expect(res.json.total).toBe(2);
    expect(names(await list(`?teamId=${other.id}`))).toEqual(["Bravo"]);
  });

  it("is a local filter: it asks auth nothing, and an unknown team is an empty page, not an error", async () => {
    await seed("Alpha");
    const res = await list("?teamId=team-nobody");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ items: [], total: 0 });
    expect(teamsAuth.calls).toBe(0);
  });

  it("combines with the other filters, and an archived team's projects stay listed (AC-4.8)", async () => {
    const team = makeTeam({ name: "Old", archived: true });
    const a = await seed("Alpha");
    const b = await seed("Bravo");
    await db.project.update({ where: { id: b.id }, data: { state: "active" } });
    await attachTeam(a.id, team.id);
    await attachTeam(b.id, team.id);
    expect(names(await list(`?teamId=${team.id}&state=active`))).toEqual(["Bravo"]);
    expect(names(await list(`?teamId=${team.id}&q=alp`))).toEqual(["Alpha"]);
  });

  it("a project carrying the team is listed once, whatever else is attached", async () => {
    const team = makeTeam();
    const second = makeTeam();
    const p = await seed("Alpha");
    await attachTeam(p.id, team.id);
    await attachTeam(p.id, second.id);
    const res = await list(`?teamId=${team.id}`);
    expect(res.json.total).toBe(1);
    expect(names(res)).toEqual(["Alpha"]);
  });

  it("refuses a malformed team id with 400", async () => {
    for (const bad of ["", "x".repeat(65)]) {
      expect((await list(`?teamId=${encodeURIComponent(bad)}`)).status).toBe(400);
    }
  });
});

describe("GET /attached-teams", () => {
  it("lists each attached team once however many projects carry it, by name, archived ones included and marked", async () => {
    const backend = makeTeam({ name: "Backend" });
    const archived = makeTeam({ name: "Alumni", archived: true });
    makeTeam({ name: "Never attached" });
    const a = await seed("Alpha");
    const b = await seed("Bravo");
    await attachTeam(a.id, backend.id);
    await attachTeam(b.id, backend.id);
    await attachTeam(b.id, archived.id);
    const res = await attached();
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      items: [
        { id: archived.id, name: "Alumni", archived: true },
        { id: backend.id, name: "Backend", archived: false },
      ],
    });
  });

  it("is empty when no project has a team, without asking auth", async () => {
    await seed("Alpha");
    const res = await attached();
    expect(res.json).toEqual({ items: [] });
    expect(teamsAuth.calls).toBe(0);
  });

  it("lists a team whose name cannot be read with null name and archived, and still answers 200 (AC-5.4)", async () => {
    const one = makeTeam({ name: "Zeta" });
    const two = makeTeam({ name: "Alpha" });
    const p = await seed("Alpha");
    await attachTeam(p.id, one.id);
    await attachTeam(p.id, two.id);
    teamsAuth.down = true;
    const res = await attached();
    expect(res.status).toBe(200);
    expect(res.json.items).toEqual(
      [one.id, two.id].sort().map((id) => ({ id, name: null, archived: null })),
    );
  });

  it("keeps what an old entry still says of a team when the refresh fails, and sorts the unknown ones after", async () => {
    const seen = makeTeam({ name: "Zeta" });
    const unseen = makeTeam({ name: "Alpha" });
    const p = await seed("Alpha");
    await attachTeam(p.id, seen.id);
    expect((await attached()).json.items).toEqual([{ id: seen.id, name: "Zeta", archived: false }]);
    await attachTeam(p.id, unseen.id);
    advanceTime(40_000);
    teamsAuth.down = true;
    const res = await attached();
    expect(res.status).toBe(200);
    expect(res.json.items).toEqual([
      { id: seen.id, name: "Zeta", archived: false },
      { id: unseen.id, name: null, archived: null },
    ]);
  });

  it("a team auth does not know is listed with null name and archived, last", async () => {
    const known = makeTeam({ name: "Zeta" });
    const p = await seed("Alpha");
    await attachTeam(p.id, known.id);
    await attachTeam(p.id, "team-gone");
    const res = await attached();
    expect(res.json.items).toEqual([
      { id: known.id, name: "Zeta", archived: false },
      { id: "team-gone", name: null, archived: null },
    ]);
  });

  it("uses the cached path: a second answer inside 30 s asks auth nothing more", async () => {
    const team = makeTeam({ name: "Backend" });
    await attachTeam((await seed("Alpha")).id, team.id);
    await attached();
    const calls = teamsAuth.idsCalls;
    await attached();
    expect(teamsAuth.idsCalls).toBe(calls);
  });

  it("is open to every projects:access holder and refused without it", async () => {
    expect((await attached("viewer")).status).toBe(200);
    expect((await attached(null)).status).toBe(401);
  });
});
