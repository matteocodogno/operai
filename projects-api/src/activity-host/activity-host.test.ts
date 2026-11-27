/**
 * The activity-host contract projects-api serves to activities-api (specs/20261110-activities T5; AC-3.2, AC-3.5,
 * AC-3.8, AC-8.1, plan.md § Host contract). Runs the ASSEMBLED app against the `*_test` database.
 */
import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { teamReadPersonLimiter, teamReadServiceLimiter } from "../lib/rateLimiter";
import { HOST_AUTHZ_WAIT_MS, HOST_PATH_REST_MS } from "../lib/hostBudget";
import { advanceTime, attachTeam, authzFake, installAuthzFake, call, db, makeTeam, resetWorld, seedDealProject, teamsAuth, type PersonaName } from "../test-support/world";
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

const resolve = (body: unknown, as: PersonaName | null = "viewer") =>
  call("POST", "/activity-host/v1/resolve", { as, body });

const resolveOne = async (id: string, as: PersonaName | null = "viewer") => {
  const res = await resolve({ entityType: "project", ids: [id] }, as);
  expect(res.status).toBe(200);
  return res.json as { reader: boolean; items: Array<Record<string, unknown>> };
};

describe("POST /activity-host/v1/resolve", () => {
  it("is 401 without a token", async () => {
    expect((await resolve({ entityType: "project", ids: [] }, null)).status).toBe(401);
  });

  it("describes an open project to any reader: label, href, assignees = PM + team (AC-3.1, AC-3.5)", async () => {
    const project = await seed({ name: "Koordy" });
    await db.projectMember.createMany({
      data: [
        { projectId: project.id, userId: "user-viewer" },
        { projectId: project.id, userId: "user-pm-ch" }, // also the PM: listed once
      ],
    });
    const body = await resolveOne(project.id, "viewer");
    expect(body.reader).toBe(true);
    expect(body.items).toHaveLength(1);
    const item = body.items[0]!;
    expect(item).toMatchObject({
      id: project.id,
      state: "open",
      writable: true,
      label: "Koordy",
      href: `/projects/${project.id}`,
      may: { write: false, manage: false },
    });
    expect(item["assignees"]).toEqual(["user-pm-ch", "user-viewer"]); // the PM first, no duplicate
  });

  it("lists only the team as assignees while a project from a deal awaits its project manager (specs/20261103-projects-handoff D42)", async () => {
    const { project } = await seedDealProject();
    await db.projectMember.create({ data: { projectId: project.id, userId: "user-viewer" } });
    const body = await resolveOne(project.id, "viewer");
    expect(body.items[0]!["assignees"]).toEqual(["user-viewer"]); // no null where the PM will be
  });

  it("answers `may.manage` from project:manage on the project's own entity (AC-3.2)", async () => {
    const ch = await seed({ entity: "welld_ch" });
    const it = await seed({ entity: "welld_it", name: "Italia" });
    const matrix: Array<[PersonaName, boolean, boolean]> = [
      ["viewer", false, false],
      ["accounting", false, false],
      ["pmCh", true, false],
      ["salesIt", false, true],
      ["admin", true, true],
    ];
    for (const [persona, onCh, onIt] of matrix) {
      const chItem = (await resolveOne(ch.id, persona)).items[0]!;
      const itItem = (await resolveOne(it.id, persona)).items[0]!;
      expect(chItem["may"]).toEqual({ write: onCh, manage: onCh });
      expect(itItem["may"]).toEqual({ write: onIt, manage: onIt });
    }
  });

  it("marks a closed or cancelled project not writable but still open to read (AC-3.8)", async () => {
    const states = ["planned", "active", "on_hold", "closed", "cancelled"] as const;
    for (const state of states) {
      const project = await seed({ state, ...(state === "on_hold" ? { stateBeforeHold: "active" } : {}) });
      const item = (await resolveOne(project.id)).items[0]!;
      expect(item["state"]).toBe("open");
      expect(item["writable"]).toBe(state !== "closed" && state !== "cancelled");
    }
  });

  it("reports an unknown id as missing, with nothing else", async () => {
    const item = (await resolveOne("nope")).items[0]!;
    expect(item).toEqual({ id: "nope", state: "missing" });
  });

  it("answers every distinct id once, in request order, mixing found and missing", async () => {
    const a = await seed({ name: "A" });
    const b = await seed({ name: "B" });
    const res = await resolve({ entityType: "project", ids: [b.id, "nope", a.id, b.id] });
    expect(res.status).toBe(200);
    expect(res.json.items.map((i: { id: string }) => i.id)).toEqual([b.id, "nope", a.id]);
    expect(res.json.items.map((i: { state: string }) => i.state)).toEqual(["open", "missing", "open"]);
  });

  it('with no ids answers only `reader` ("may I read at all?")', async () => {
    expect((await resolve({ entityType: "project", ids: [] }, "viewer")).json).toEqual({ reader: true, items: [] });
  });

  it("tells a caller without projects:access `reader:false`, 200, and leaks no project (AC-8.1)", async () => {
    const project = await seed({ name: "Secret" });
    const res = await resolve({ entityType: "project", ids: [project.id, "nope"] }, "outsider");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      reader: false,
      items: [
        { id: project.id, state: "missing" },
        { id: "nope", state: "missing" },
      ],
    });
    expect((await resolve({ entityType: "project", ids: [] }, "outsider")).json).toEqual({ reader: false, items: [] });
  });

  it("is never cached", async () => {
    const res = await resolve({ entityType: "project", ids: [] });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("is 400 `validation_failed` for another entity type, more than 25 ids, an empty id, an unknown member or no ids", async () => {
    const ids26 = Array.from({ length: 26 }, (_, i) => `p${i}`);
    for (const body of [
      { entityType: "company", ids: [] },
      { entityType: "project", ids: ids26 },
      { entityType: "project", ids: [""] },
      { entityType: "project", ids: [], extra: 1 },
      { entityType: "project" },
    ]) {
      const res = await resolve(body);
      expect(res.status).toBe(400);
    }
    expect((await resolve({ entityType: "project", ids: ids26.slice(0, 25) })).status).toBe(200);
  });

  it("400 validation_failed for a NUL character in any id: Postgres text cannot hold it, so it is refused before the lookup, never a 500 (security re-review)", async () => {
    const nul = "pro\u0000ject";
    const asked = await resolve({ entityType: "project", ids: [nul] });
    expect(asked.status).toBe(400);
    expect(asked.json).toMatchObject({ code: "validation_failed", field: "ids.0" });
    expect((await resolve({ entityType: "project", ids: [], related: { deal: [nul] } })).status).toBe(400);
  });

  it("ignores `related` (CRM-only), which this host never answers", async () => {
    const res = await resolve({ entityType: "project", ids: [], related: { deal: ["d1"] } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ reader: true, items: [] });
  });

  it("changes nothing", async () => {
    const project = await seed();
    const before = JSON.stringify(await db.project.findMany());
    await resolve({ entityType: "project", ids: [project.id] }, "admin");
    expect(JSON.stringify(await db.project.findMany())).toBe(before);
  });
});

// ─── Teams (specs/20261126-teams T13: AC-4.4, AC-4.5, AC-5.1, AC-5.2, AC-5.4, AC-5.6) ───────────────────────────────

const assigneesOf = async (id: string, as: PersonaName | null = "viewer") => (await resolveOne(id, as)).items[0]!["assignees"];

describe("POST /activity-host/v1/resolve — attached teams", () => {
  it("answers assignees as the onProject vector: PM, listed members, then each team's counted members, once each (AC-4.4, AC-5.2)", async () => {
    const project = await seed();
    await db.projectMember.create({ data: { projectId: project.id, userId: "user-viewer" } });
    const team = makeTeam({
      members: [
        { id: "user-colleague" },
        { id: "user-viewer" }, // also listed: once
        { id: "user-outsider" }, // holds no Projects access: not counted (AC-4.7)
        { id: "user-sales-it", active: false }, // deactivated: not counted
      ],
      archived: true, // an archived team still counts
    });
    await attachTeam(project.id, team.id);
    expect(await assigneesOf(project.id)).toEqual(["user-pm-ch", "user-viewer", "user-colleague"]);
  });

  it("detaching a team removes a team-only person and keeps a listed one (AC-4.5)", async () => {
    const project = await seed();
    await db.projectMember.create({ data: { projectId: project.id, userId: "user-viewer" } });
    const team = makeTeam({ members: [{ id: "user-viewer" }, { id: "user-colleague" }] });
    await attachTeam(project.id, team.id);
    expect(await assigneesOf(project.id)).toEqual(["user-pm-ch", "user-viewer", "user-colleague"]);
    await db.attachedTeam.deleteMany({ where: { projectId: project.id } });
    expect(await assigneesOf(project.id)).toEqual(["user-pm-ch", "user-viewer"]);
  });

  it("reads a team's members live: a removal shows within 60 s through the cache rule (AC-5.1, AC-5.2)", async () => {
    const project = await seed();
    const team = makeTeam({ members: [{ id: "user-colleague" }] });
    await attachTeam(project.id, team.id);
    expect(await assigneesOf(project.id)).toContain("user-colleague");
    expect(await assigneesOf(project.id)).toContain("user-colleague");
    expect(teamsAuth.idsCalls).toBe(1); // the second answer came from the cache
    team.members = [];
    advanceTime(31_000);
    expect(await assigneesOf(project.id)).toEqual(["user-pm-ch"]);
  });

  it("says null (unknown, never the listed members alone) for a project with teams while auth fails; the rest of the item and the batch stand (AC-5.4, D3)", async () => {
    const withTeam = await seed({ name: "With" });
    const without = await seed({ name: "Without" });
    await db.projectMember.create({ data: { projectId: withTeam.id, userId: "user-viewer" } });
    await db.projectMember.create({ data: { projectId: without.id, userId: "user-viewer" } });
    await attachTeam(withTeam.id, makeTeam({ members: [{ id: "user-colleague" }] }).id);
    teamsAuth.down = true;

    const res = await resolve({ entityType: "project", ids: [withTeam.id, without.id] });
    expect(res.status).toBe(200);
    const [a, b] = res.json.items as Array<Record<string, unknown>>;
    expect(a).toMatchObject({ id: withTeam.id, state: "open", writable: true, label: "With", may: { write: false, manage: false } });
    expect(a!["assignees"]).toBeNull();
    expect(b!["assignees"]).toEqual(["user-pm-ch", "user-viewer"]); // no team: never waits on auth
  });

  it("says null when auth does not know an attached team, and when one of two teams is unavailable (D3)", async () => {
    const project = await seed();
    await attachTeam(project.id, "team-unknown-to-auth");
    expect(await assigneesOf(project.id)).toBeNull();

    const other = await seed({ name: "Two" });
    await attachTeam(other.id, makeTeam({ members: [{ id: "user-colleague" }] }).id);
    await attachTeam(other.id, "team-also-unknown");
    expect(await assigneesOf(other.id)).toBeNull();
  });

  it("serves a fresh-enough cached team through an outage, and null once it is older than 60 s (D2)", async () => {
    const project = await seed();
    await attachTeam(project.id, makeTeam({ members: [{ id: "user-colleague" }] }).id);
    expect(await assigneesOf(project.id)).toContain("user-colleague");
    teamsAuth.down = true;
    advanceTime(45_000);
    expect(await assigneesOf(project.id)).toContain("user-colleague");
    advanceTime(20_000);
    expect(await assigneesOf(project.id)).toBeNull();
  });

  it("makes no team read for a caller without projects:access, nor for an empty batch (D3 point 5)", async () => {
    const project = await seed();
    await attachTeam(project.id, makeTeam({ members: [{ id: "user-colleague" }] }).id);
    expect((await resolve({ entityType: "project", ids: [project.id] }, "outsider")).json.items).toEqual([
      { id: project.id, state: "missing" },
    ]);
    await resolve({ entityType: "project", ids: [] });
    expect(teamsAuth.calls).toBe(0);
  });

  it("reads each distinct team once for a whole batch", async () => {
    const shared = makeTeam({ members: [{ id: "user-colleague" }] });
    const a = await seed({ name: "A" });
    const b = await seed({ name: "B" });
    await attachTeam(a.id, shared.id);
    await attachTeam(b.id, shared.id);
    const res = await resolve({ entityType: "project", ids: [a.id, b.id] });
    expect(res.status).toBe(200);
    expect(teamsAuth.idsCalls).toBe(1);
    expect(teamsAuth.requests[0]!.ids).toEqual([shared.id]);
  });

  it("never consults the page-read windows, whoever the caller is, even over their limit (AC-5.6)", async () => {
    const project = await seed();
    await attachTeam(project.id, makeTeam({ members: [{ id: "user-colleague" }] }).id);
    for (let i = 0; i < 120; i++) teamReadPersonLimiter.consume("user-viewer");
    const spies = [
      spyOn(teamReadPersonLimiter, "peek"),
      spyOn(teamReadPersonLimiter, "consume"),
      spyOn(teamReadServiceLimiter, "peek"),
      spyOn(teamReadServiceLimiter, "consume"),
    ];
    try {
      expect(await assigneesOf(project.id, "viewer")).toContain("user-colleague"); // viewer is over their own limit
      expect(await assigneesOf(project.id, "colleague")).toContain("user-colleague");
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("POST /activity-host/v1/resolve under a slow permission check (R13 a)", () => {
  it("answers 503 authz_unavailable within the permission wait plus the rest while auth holds /authz/resolve, then answers normally once it has", async () => {
    installAuthzFake(); // the harness's resolve is process-wide and other files swap it
    const project = await seed();
    let release!: () => void;
    authzFake.hold = new Promise<void>((done) => {
      release = done;
    });
    try {
      const started = Date.now();
      const res = await resolve({ entityType: "project", ids: [project.id] });
      expect(res.status).toBe(503);
      expect(res.json.code).toBe("authz_unavailable");
      expect(Date.now() - started).toBeLessThan(HOST_AUTHZ_WAIT_MS + HOST_PATH_REST_MS);
      expect(authzFake.calls).toBe(1);
    } finally {
      release();
    }
    await new Promise<void>((done) => setTimeout(done, 30)); // the flight, not aborted, fills the cache
    const retry = await resolve({ entityType: "project", ids: [project.id] });
    expect(retry.status).toBe(200);
    expect(retry.json.items[0].state).toBe("open");
    expect(authzFake.calls).toBe(1); // served from the cache the late answer filled
  });
});
