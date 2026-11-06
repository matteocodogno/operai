/**
 * The project-manager pick and the awaiting state (specs/022 T27; AC-4.5, AC-4.7, AC-4.8, AC-4.9; D46, D47,
 * D48; T18 L5, L6). Runs the ASSEMBLED app against the `*_test` database; auth, the identity service and
 * crm-api are the fakes of test-support/world.ts. Projects are seeded straight in the database.
 *
 * Who is who (test-support/world.ts personas): `opsCh` is the ops-manager of wellD CH (`purchase-order:receive`
 * for its own entity, which is the seeded purchase order's `opsManagerId`, `user-ops`); `admin` holds it
 * unconditioned; `pmCh` and `salesCh` manage wellD CH projects and hold no `receive`.
 */
import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { appAccess, call, db, identities, resetWorld, seedDealProject, type PersonaName } from "../test-support/world";
import type { ResolvedPermission } from "../authz/resolveClient";
import type { Prisma } from "../lib/generated/prisma/client";

// After the world: its harness mocks the JWT and authz clients `auth/guards` sits behind.
const { canPickProjectManager } = await import("./pick");

beforeEach(resetWorld);

const patch = (id: string, body: Record<string, unknown>, as: PersonaName | null = "opsCh", ifMatch: number | string = 1) =>
  call("PATCH", `/projects/${id}`, { as, body, ifMatch });

const stored = (id: string) => db.project.findUniqueOrThrow({ where: { id } });

/** A hand-made `internal` project with a project manager: never awaiting. */
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

describe("clearing the project manager (AC-4.9)", () => {
  it("is 422 `project_manager_required` while the project awaits one, for the ops-manager and the admin alike", async () => {
    const { project } = await seedDealProject();
    for (const as of ["opsCh", "admin"] as const) {
      const res = await patch(project.id, { projectManagerId: null }, as);
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ status: 422, code: "project_manager_required" });
    }
    expect(await stored(project.id)).toMatchObject({ projectManagerId: null, version: 1 });
  });

  it("is 422 `project_manager_required` once it has one: a project is never left without (A34)", async () => {
    const project = await seed();
    const res = await patch(project.id, { projectManagerId: null }, "pmCh");
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ code: "project_manager_required" });
    expect(await stored(project.id)).toMatchObject({ projectManagerId: "user-pm-ch", version: 1 });
  });

  it("is refused with a name in the same body too, and changes nothing", async () => {
    const project = await seed();
    const res = await patch(project.id, { name: "Renamed", projectManagerId: null }, "pmCh");
    expect(res.status).toBe(422);
    expect(await stored(project.id)).toMatchObject({ name: "Koordy", version: 1 });
  });
});

describe("picking the project manager of an awaiting project (AC-4.8, D46, D47)", () => {
  it("lets the purchase order's ops-manager set it: 200, the person shown, no longer awaiting, version bumped", async () => {
    const { project } = await seedDealProject();
    const res = await patch(project.id, { projectManagerId: "user-colleague" }, "opsCh");
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"2"');
    expect(res.json).toMatchObject({
      id: project.id,
      projectManager: { id: "user-colleague", name: "Name of user-colleague", deleted: false },
      awaitingProjectManager: false,
      version: 2,
    });
    expect(await stored(project.id)).toMatchObject({ projectManagerId: "user-colleague", version: 2 });
    // The page answers the same way afterwards.
    const page = await call("GET", `/projects/${project.id}`, { as: "viewer" });
    expect(page.json).toMatchObject({ awaitingProjectManager: false, projectManager: { id: "user-colleague" } });
  });

  it("lets an admin, who holds `purchase-order:receive` for every entity, set it in the ops-manager's place (D47)", async () => {
    const { project } = await seedDealProject();
    const res = await patch(project.id, { projectManagerId: "user-colleague" }, "admin");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ awaitingProjectManager: false, projectManager: { id: "user-colleague" } });
  });

  it("lets the ops-manager pick themselves, with no access check on the caller", async () => {
    const { project } = await seedDealProject();
    identities.down = true;
    const res = await patch(project.id, { projectManagerId: "user-ops" }, "opsCh");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ projectManager: { id: "user-ops" }, awaitingProjectManager: false });
  });

  describe("refuses everyone else: 403 `not_ops_manager`, and changes nothing", () => {
    const refused = async (as: PersonaName, opsManagerId = "user-ops") => {
      const { project } = await seedDealProject({ order: { opsManagerId } });
      const res = await patch(project.id, { name: "Renamed", projectManagerId: "user-colleague" }, as);
      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({ status: 403, code: "not_ops_manager" });
      // Neither the project manager nor the name in the same body was written.
      expect(await stored(project.id)).toMatchObject({ projectManagerId: null, name: "Project fixed_price", version: 1 });
    };

    it("another ops-manager: the order is assigned to someone else", () => refused("opsCh", "user-colleague"));
    it("a sales of the entity, a holder of manage projects", () => refused("salesCh"));
    it("a project manager of the entity, a holder of manage projects", () => refused("pmCh"));
    it("the assignee after losing `purchase-order:receive` (read from the row, not remembered)", () => refused("pmCh", "user-pm-ch"));

    it("a reader: no manage either, so the route's own `forbidden`", async () => {
      const { project } = await seedDealProject({ order: { opsManagerId: "user-viewer" } });
      const res = await patch(project.id, { projectManagerId: "user-colleague" }, "viewer");
      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({ code: "forbidden" });
      expect((await stored(project.id)).projectManagerId).toBeNull();
    });
  });

  it("refuses the person the ops-manager picks when they hold no project access: 422 `not_project_user` (AC-1.6)", async () => {
    const { project } = await seedDealProject();
    const res = await patch(project.id, { projectManagerId: "user-employee" }, "opsCh");
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ code: "not_project_user", userIds: ["user-employee"] });
    expect(await stored(project.id)).toMatchObject({ projectManagerId: null, version: 1 });
  });

  it("refuses a person whose access was revoked since: checked live", async () => {
    const { project } = await seedDealProject();
    appAccess.projects.delete("user-colleague");
    expect((await patch(project.id, { projectManagerId: "user-colleague" }, "opsCh")).status).toBe(422);
  });

  it("is 503 `identity_unavailable` when auth cannot say whether the person holds access: never an allow", async () => {
    const { project } = await seedDealProject();
    identities.down = true;
    const res = await patch(project.id, { projectManagerId: "user-colleague" }, "opsCh");
    expect(res.status).toBe(503);
    expect((await stored(project.id)).projectManagerId).toBeNull();
  });

  it("is checked and written under the version: a stale If-Match is 409 for the ops-manager", async () => {
    const { project } = await seedDealProject();
    const res = await patch(project.id, { projectManagerId: "user-colleague" }, "opsCh", 7);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: "version_conflict", currentVersion: 1 });
    expect((await stored(project.id)).projectManagerId).toBeNull();
  });

  it("lets exactly one of two simultaneous picks of the same version win", async () => {
    const { project } = await seedDealProject();
    const results = await Promise.all([
      patch(project.id, { projectManagerId: "user-colleague" }, "opsCh"),
      patch(project.id, { projectManagerId: "user-viewer" }, "admin"),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    const winner = results.find((res) => res.status === 200)!;
    expect(await stored(project.id)).toMatchObject({ projectManagerId: winner.json.projectManager.id, version: 2 });
  });

  it("needs an If-Match like every write: 428 without one", async () => {
    const { project } = await seedDealProject();
    const res = await call("PATCH", `/projects/${project.id}`, { as: "opsCh", body: { projectManagerId: "user-colleague" } });
    expect(res.status).toBe(428);
    expect((await stored(project.id)).projectManagerId).toBeNull();
  });

  /** The structured lines (JSON objects) the console logged while `run` ran. */
  const loggedEvents = async (run: () => Promise<unknown>): Promise<Record<string, unknown>[]> => {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    try {
      await run();
    } finally {
      log.mockRestore();
    }
    return lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  it("logs one structured line per pick, with the event, the project and the actor and nothing else (T18 L6)", async () => {
    const { project } = await seedDealProject();
    const events = await loggedEvents(() => patch(project.id, { projectManagerId: "user-colleague" }, "opsCh"));
    expect(events).toEqual([{ event: "project_manager.picked", projectId: project.id, actorId: "user-ops" }]);
  });

  it("logs no pick for a refused attempt", async () => {
    const { project } = await seedDealProject();
    const events = await loggedEvents(() => patch(project.id, { projectManagerId: "user-colleague" }, "pmCh"));
    expect(events).toEqual([]);
  });

  describe("after the pick, the project manager changes as in specs/021 (AC-4.8, AC-4.9)", () => {
    it("lets any holder of manage projects for the entity change it, not only the ops-manager", async () => {
      const { project } = await seedDealProject({ project: { projectManagerId: "user-colleague" } });
      expect((await patch(project.id, { projectManagerId: "user-viewer" }, "pmCh", 1)).status).toBe(200);
      expect((await patch(project.id, { projectManagerId: "user-pm-ch" }, "salesCh", 2)).status).toBe(200);
      expect((await patch(project.id, { projectManagerId: "user-sales-ch" }, "opsCh", 3)).status).toBe(200);
      expect(await stored(project.id)).toMatchObject({ projectManagerId: "user-sales-ch", version: 4 });
    });

    it("is not logged as a pick", async () => {
      const { project } = await seedDealProject({ project: { projectManagerId: "user-colleague" } });
      const events = await loggedEvents(() => patch(project.id, { projectManagerId: "user-viewer" }, "pmCh"));
      expect(events).toEqual([]);
    });

    it("still refuses a person without project access", async () => {
      const { project } = await seedDealProject({ project: { projectManagerId: "user-colleague" } });
      const res = await patch(project.id, { projectManagerId: "user-employee" }, "pmCh");
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ code: "not_project_user" });
    });
  });
});

describe("canPickProjectManager: conditions decide, not the presence of a grant (T18 L5)", () => {
  const receive = (conditions: ResolvedPermission["conditions"]): ResolvedPermission => ({ resource: "purchase-order", action: "receive", conditions });
  const ENTITY = { attributes: [{ key: "entity", match: "user" }] } as const;
  const caller = (permissions: ResolvedPermission[], entity: string | null, userId = "user-ops") =>
    ({ get: (key: string) => (key === "authz" ? { permissions, entity } : userId) }) as unknown as Parameters<typeof canPickProjectManager>[0];
  const order = (opsManagerId: string) => ({ opsManagerId });

  it("lets the assignee holding `receive` for the project's entity, and nobody else holding it", () => {
    expect(canPickProjectManager(caller([receive(ENTITY)], "welld_ch"), { entity: "welld_ch", purchaseOrder: order("user-ops") })).toBe(true);
    expect(canPickProjectManager(caller([receive(ENTITY)], "welld_ch", "user-other"), { entity: "welld_ch", purchaseOrder: order("user-ops") })).toBe(false);
  });

  it("refuses an assignee whose `receive` covers only the other entity, or none, or a condition it cannot evaluate", () => {
    const project = { entity: "welld_ch", purchaseOrder: order("user-ops") } as const;
    expect(canPickProjectManager(caller([receive(ENTITY)], "welld_it"), project)).toBe(false);
    expect(canPickProjectManager(caller([receive(ENTITY)], null), project)).toBe(false);
    expect(canPickProjectManager(caller([], "welld_ch"), project)).toBe(false);
    expect(canPickProjectManager(caller([receive({ attributes: [{ key: "department", match: "user" }] })], "welld_ch"), project)).toBe(false);
  });

  it("lets an unconditioned holder — an admin — pick for any project, whoever the assignee is", () => {
    expect(canPickProjectManager(caller([receive(null)], null, "user-admin"), { entity: "welld_it", purchaseOrder: order("user-ops") })).toBe(true);
    expect(canPickProjectManager(caller([receive(null)], null, "user-admin"), { entity: "welld_ch", purchaseOrder: null })).toBe(true);
  });

  it("refuses an ops-manager when the project has no purchase order to be the ops-manager of", () => {
    expect(canPickProjectManager(caller([receive(ENTITY)], "welld_ch"), { entity: "welld_ch", purchaseOrder: null })).toBe(false);
  });
});

describe("every other edit of an awaiting project follows specs/021 (AC-4.7)", () => {
  it("lets any holder of manage projects of the entity rename it, and it still awaits", async () => {
    const { project } = await seedDealProject();
    for (const [i, as] of (["pmCh", "salesCh", "opsCh"] as const).entries()) {
      const res = await patch(project.id, { name: `Renamed ${i}` }, as, i + 1);
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ name: `Renamed ${i}`, projectManager: null, awaitingProjectManager: true });
    }
  });
});
