/**
 * Project states (specs/021 T6; AC-1.2, AC-1.3, AC-1.7, AC-4.4; the type change is gone, specs/022
 * T23, A30). Runs the
 * ASSEMBLED app against the `*_test` database; auth and the identity service are the fakes of
 * test-support/world.ts. Projects are seeded straight in the database (the API under test is
 * not its own fixture); an `internal` project needs no company, so no CRM fixture either.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { call, db, resetWorld, seedDealProject, type PersonaName } from "../test-support/world";
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

const transition = (id: string, to: unknown, as: PersonaName | null = "pmCh", ifMatch: number | string = 1) =>
  call("POST", `/projects/${id}/transitions`, { as, body: { to }, ifMatch });

type State = "planned" | "active" | "on_hold" | "closed" | "cancelled";
const STATES: readonly State[] = ["planned", "active", "on_hold", "closed", "cancelled"];

/**
 * AC-1.3 / A10 written out as data, NOT computed by the code under test: where a project in
 * each starting position may go. `on_hold` is two positions: it returns only to the state it left.
 */
const MATRIX: readonly { from: string; seed: Partial<Prisma.ProjectUncheckedCreateInput>; allowed: readonly State[] }[] = [
  { from: "planned", seed: { state: "planned" }, allowed: ["active", "on_hold", "cancelled"] },
  { from: "active", seed: { state: "active" }, allowed: ["on_hold", "closed", "cancelled"] },
  { from: "on_hold (left planned)", seed: { state: "on_hold", stateBeforeHold: "planned" }, allowed: ["planned", "cancelled"] },
  { from: "on_hold (left active)", seed: { state: "on_hold", stateBeforeHold: "active" }, allowed: ["active", "cancelled"] },
  { from: "closed", seed: { state: "closed" }, allowed: ["active"] },
  { from: "cancelled", seed: { state: "cancelled" }, allowed: [] },
];

describe("the AC-1.3 matrix, every pair", () => {
  for (const { from, seed: start, allowed } of MATRIX) {
    for (const to of STATES) {
      if (allowed.includes(to)) {
        it(`${from} → ${to} is allowed`, async () => {
          const project = await seed(start);
          const res = await transition(project.id, to);
          expect(res.status).toBe(200);
          expect(res.json).toMatchObject({ state: to, version: 2 });
          // Putting a project on hold remembers where it was; every other move forgets it (a CHECK).
          expect(await db.project.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({
            state: to,
            stateBeforeHold: to === "on_hold" ? start.state : null,
          });
        });
      } else {
        it(`${from} → ${to} is refused: 409 invalid_transition, nothing changes`, async () => {
          const project = await seed(start);
          const res = await transition(project.id, to);
          expect(res.status).toBe(409);
          expect(res.json).toMatchObject({ status: 409, code: "invalid_transition" });
          expect(await db.project.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({
            state: start.state,
            stateBeforeHold: start.stateBeforeHold ?? null,
            version: 1,
          });
        });
      }
    }
  }
});

describe("POST /projects/:id/transitions", () => {
  it("starts a planned project: 200 with the Project, the new ETag, and the state stored (AC-1.3)", async () => {
    const project = await seed();
    const res = await transition(project.id, "active");
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"2"');
    expect(res.json).toMatchObject({ id: project.id, state: "active", version: 2, name: "Koordy" });
    expect(await db.project.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({
      state: "active",
      stateBeforeHold: null,
      version: 2,
    });
  });

  it("is 404 for an unknown project", async () => {
    const res = await transition("nope", "active");
    expect(res.status).toBe(404);
  });

  it.each(["viewer", "accounting"] as const)("refuses %s, who manages nothing: 403 `forbidden`, even with a bad body (AC-4.4)", async (as) => {
    const project = await seed();
    const res = await transition(project.id, "active", as);
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "forbidden" });
    expect((await transition(project.id, "retired", as)).status).toBe(403);
    expect((await db.project.findUniqueOrThrow({ where: { id: project.id } })).state).toBe("planned");
  });

  it("refuses the caller with no module access (403) and no token (401) (AC-4.2)", async () => {
    const project = await seed();
    expect((await transition(project.id, "active", "outsider")).status).toBe(403);
    expect((await transition(project.id, "active", null)).status).toBe(401);
  });

  it("refuses a manager of the other entity: 403 `out_of_scope`; an admin and the entity's own manager may (AC-4.4)", async () => {
    const itProject = await seed({ entity: "welld_it" });
    const res = await transition(itProject.id, "active", "pmCh");
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "out_of_scope" });
    expect((await db.project.findUniqueOrThrow({ where: { id: itProject.id } })).state).toBe("planned");
    expect((await transition(itProject.id, "active", "salesIt")).status).toBe(200);
    const chProject = await seed({ entity: "welld_ch" });
    expect((await transition(chProject.id, "active", "admin")).status).toBe(200);
  });

  it.each([
    ["an unknown state", { to: "retired" }],
    ["no target", {}],
    ["an extra member", { to: "active", state: "closed" }],
  ])("is 400 `validation_failed` for %s", async (_label, body) => {
    const project = await seed();
    const res = await call("POST", `/projects/${project.id}/transitions`, { as: "pmCh", body, ifMatch: 1 });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ status: 400, code: "validation_failed" });
  });

  it("needs an If-Match: 428 `precondition_required`, nothing changes (AC-1.7)", async () => {
    const project = await seed();
    const res = await call("POST", `/projects/${project.id}/transitions`, { as: "pmCh", body: { to: "active" } });
    expect(res.status).toBe(428);
    expect(res.json).toMatchObject({ code: "precondition_required" });
    expect((await db.project.findUniqueOrThrow({ where: { id: project.id } })).state).toBe("planned");
  });

  it("refuses a stale version: 409 `version_conflict` with the current one, nothing changes (AC-1.7)", async () => {
    const project = await seed({ version: 3 });
    const res = await transition(project.id, "active", "pmCh", 2);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: "version_conflict", currentVersion: 3 });
    expect(await db.project.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({ state: "planned", version: 3 });
    // A stale view wins over "not allowed": the person is asked to reload first.
    const stale = await transition(project.id, "closed", "pmCh", 2);
    expect(stale.json).toMatchObject({ code: "version_conflict" });
  });

  it("lets only one of two saves of the same version win (AC-1.7)", async () => {
    const project = await seed();
    const [a, b] = await Promise.all([transition(project.id, "active"), transition(project.id, "cancelled")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.json).toMatchObject({ code: "version_conflict" });
    expect((await db.project.findUniqueOrThrow({ where: { id: project.id } })).version).toBe(2);
  });
});

describe("a project awaiting its project manager cannot be started (specs/022 T27; AC-4.7, D48)", () => {
  it.each(["pmCh", "opsCh", "admin"] as const)("refuses `planned` → `active` for %s: 409 `awaiting_project_manager`, nothing changes", async (as) => {
    const { project } = await seedDealProject();
    const res = await transition(project.id, "active", as);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ status: 409, code: "awaiting_project_manager" });
    expect(await db.project.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({ state: "planned", version: 1 });
  });

  it.each(["on_hold", "cancelled"] as const)("still allows `planned` → %s: every other move is specs/021's", async (to) => {
    const { project } = await seedDealProject();
    const res = await transition(project.id, to, "pmCh");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ state: to, projectManager: null, awaitingProjectManager: true });
  });

  it("still refuses a move specs/021 refuses with its own code, and a stale version first", async () => {
    const { project } = await seedDealProject();
    expect((await transition(project.id, "closed")).json).toMatchObject({ code: "invalid_transition" });
    expect((await transition(project.id, "active", "pmCh", 9)).json).toMatchObject({ code: "version_conflict" });
  });

  it("returns a held awaiting project to `planned`, and still not to `active`", async () => {
    const { project } = await seedDealProject();
    expect((await transition(project.id, "on_hold", "pmCh", 1)).status).toBe(200);
    expect((await transition(project.id, "active", "pmCh", 2)).json).toMatchObject({ code: "invalid_transition" });
    expect((await transition(project.id, "planned", "pmCh", 2)).status).toBe(200);
    expect((await transition(project.id, "active", "pmCh", 3)).json).toMatchObject({ code: "awaiting_project_manager" });
  });

  it("starts once the project manager is picked", async () => {
    const { project } = await seedDealProject();
    expect((await call("PATCH", `/projects/${project.id}`, { as: "opsCh", body: { projectManagerId: "user-colleague" }, ifMatch: 1 })).status).toBe(200);
    const res = await transition(project.id, "active", "pmCh", 2);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ state: "active", awaitingProjectManager: false });
  });

  it("does not stop a hand-made project, which never awaits", async () => {
    const project = await seed();
    expect((await transition(project.id, "active")).status).toBe(200);
  });
});

describe("the type of a project never changes (specs/022 A30, D40)", () => {
  it.each(["pmCh", "admin", "viewer"] as const)("has no `PUT /projects/:id/type` any more, for %s: 404, nothing changes", async (as) => {
    const project = await seed({ version: 3 });
    const res = await call("PUT", `/projects/${project.id}/type`, { as, body: { type: "saas" }, ifMatch: 3 });
    expect(res.status).toBe(404);
    expect(await db.project.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({ type: "internal", version: 3 });
  });
});
