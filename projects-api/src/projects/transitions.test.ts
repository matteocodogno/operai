/**
 * Project states and the type change (specs/025 T6; AC-1.2, AC-1.3, AC-1.7, AC-4.4). Runs the
 * ASSEMBLED app against the `*_test` database; auth and the identity service are the fakes of
 * test-support/world.ts. Projects are seeded straight in the database (the API under test is
 * not its own fixture); an `internal` project needs no company, so no CRM fixture either.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { call, db, resetWorld, type PersonaName } from "../test-support/world";
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

type Type = "t_and_m" | "fixed_price" | "maintenance" | "saas" | "internal";
const TYPES: readonly Type[] = ["t_and_m", "fixed_price", "maintenance", "saas", "internal"];
const CLIENT = new Set<Type>(["t_and_m", "fixed_price", "maintenance"]);

/** A project of `type`, with the company the database requires of a client type. */
const seedOfType = (type: Type, over: Partial<Prisma.ProjectUncheckedCreateInput> = {}) =>
  seed({ type, companyId: CLIENT.has(type) ? "co-acme" : null, ...over });

const changeType = (id: string, type: unknown, as: PersonaName | null = "pmCh", ifMatch: number | string = 1) =>
  call("PUT", `/projects/${id}/type`, { as, body: { type }, ifMatch });

describe("PUT /projects/:id/type", () => {
  it("turns an internal tool into a SaaS product, keeping its state: 200 with the Project and the new ETag (AC-1.2)", async () => {
    const project = await seedOfType("internal", { state: "active" });
    const res = await changeType(project.id, "saas");
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"2"');
    expect(res.json).toMatchObject({ id: project.id, type: "saas", state: "active", company: null, version: 2 });
    expect(await db.project.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({
      type: "saas",
      state: "active",
      companyId: null,
      version: 2,
    });
  });

  describe("every other change is refused: 409 `type_change_refused`, nothing changes (AC-1.2)", () => {
    for (const from of TYPES) {
      for (const to of TYPES) {
        if (from === "internal" && to === "saas") continue;
        it(`${from} → ${to}`, async () => {
          const project = await seedOfType(from);
          const res = await changeType(project.id, to);
          expect(res.status).toBe(409);
          expect(res.json).toMatchObject({ status: 409, code: "type_change_refused" });
          expect(await db.project.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({ type: from, version: 1 });
        });
      }
    }
  });

  it("is 404 for an unknown project", async () => {
    expect((await changeType("nope", "saas")).status).toBe(404);
  });

  it.each(["viewer", "accounting"] as const)("refuses %s, who manages nothing: 403 `forbidden` (AC-4.4)", async (as) => {
    const project = await seedOfType("internal");
    const res = await changeType(project.id, "saas", as);
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "forbidden" });
    expect((await db.project.findUniqueOrThrow({ where: { id: project.id } })).type).toBe("internal");
  });

  it("refuses no module access (403) and no token (401), and a manager of the other entity: 403 `out_of_scope`", async () => {
    const project = await seedOfType("internal", { entity: "welld_it" });
    expect((await changeType(project.id, "saas", "outsider")).status).toBe(403);
    expect((await changeType(project.id, "saas", null)).status).toBe(401);
    const res = await changeType(project.id, "saas", "pmCh");
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "out_of_scope" });
    expect((await changeType(project.id, "saas", "salesIt")).status).toBe(200);
  });

  it.each([
    ["an unknown type", { type: "retainer" }],
    ["no type", {}],
    ["an extra member", { type: "saas", state: "closed" }],
  ])("is 400 `validation_failed` for %s", async (_label, body) => {
    const project = await seedOfType("internal");
    const res = await call("PUT", `/projects/${project.id}/type`, { as: "pmCh", body, ifMatch: 1 });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ status: 400, code: "validation_failed" });
  });

  it("needs an If-Match (428) and refuses a stale one (409 `version_conflict`) (AC-1.7)", async () => {
    const project = await seedOfType("internal", { version: 3 });
    const missing = await call("PUT", `/projects/${project.id}/type`, { as: "pmCh", body: { type: "saas" } });
    expect(missing.status).toBe(428);
    expect(missing.json).toMatchObject({ code: "precondition_required" });
    const stale = await changeType(project.id, "saas", "pmCh", 2);
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: "version_conflict", currentVersion: 3 });
    expect(await db.project.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({ type: "internal", version: 3 });
  });
});
