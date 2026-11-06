/**
 * Authorization matrix over the ASSEMBLED app (specs/021-projects T10; AC-4.2 – AC-4.6, ADR-0014;
 * specs/022 T9, T23 – T29: the to-start queue, terms and purchase order routes, the referent, the
 * project-manager pick; AC-1.1, AC-1.2, AC-1.9, AC-3.7, AC-4.8, AC-5.1).
 *
 * The route list is read from the app's own table, so a route added without a row here fails the
 * inventory test, and one added without a guard fails the matrix. Every route is then driven by
 * every persona against a record of each entity:
 *
 *   outsider    no grant of the module (an `employee`, AC-4.6)         -> 403 `forbidden` everywhere
 *   viewer      `projects:access` only                                   -> reads, manages nothing (AC-4.3)
 *   pmCh        `project-manager` in welld_ch: manage, entity-scoped     -> own entity only (AC-4.4)
 *   salesIt     `sales` in welld_it: manage + take, entity-scoped        -> own entity only (AC-4.4, AC-1.9)
 *   salesCh     `sales` in welld_ch: manage + take, entity-scoped        -> own entity only (AC-1.9)
 *   opsCh       `ops-manager` in welld_ch: manage + receive, entity-scoped -> own entity only; takes nothing (AC-4.8)
 *   accounting  `projects:access` + `purchase-order:bexio`               -> reads, writes the Bexio id (AC-4.5)
 *   admin       everything, unscoped                                     -> both entities (AC-4.6)
 *
 * What each persona holds is written out below as literals (the spec's grants), NOT computed from
 * the test-support personas or from the guards under test. A refused write must also change
 * nothing: the database is compared before and after.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { setupTestAuth } from "./test-support/testAuth";
import { PERSONAS, app, call, crm, db, makeDeal, resetWorld, seedDealProject, type PersonaName } from "./test-support/world";

beforeEach(async () => {
  await resetWorld();
  crm.companies = [{ id: "co-acme", name: "Acme SA", entity: "welld_ch", archived: false }];
});

type Entity = "welld_ch" | "welld_it";
const ENTITIES: readonly Entity[] = ["welld_ch", "welld_it"];

// ─── The routes, and what each one needs ─────────────────────────────────────

/**
 *   access       `projects:access` and nothing more (every holder reads every record, D13)
 *   manage-any   `project:manage` for at least one entity (a lookup, no record involved)
 *   manage       `project:manage` for the RECORD's entity (`out_of_scope` for the other one)
 *   take-any     `handoff:take` for at least one entity (specs/022 T24: the queue is read whole by any taker)
 *   take         `handoff:take` AND `project:manage` for the CRM DEAL's entity, which the CRM says
 *                (`out_of_scope` for the other one; `forbidden` without `handoff:take` at all)
 *   bexio        `purchase-order:bexio`, not entity-scoped
 *   pick         `manage` for the project's entity, and then — the project having no project manager yet —
 *                to be the purchase order's ops-manager (`purchase-order:receive` for the project's entity
 *                AND named on the row) or to hold `purchase-order:receive` for every entity (the admin
 *                override): `not_ops_manager` otherwise (specs/022 T27, D46, D47)
 */
type Need = "access" | "manage-any" | "manage" | "take-any" | "take" | "bexio" | "pick";

interface Req {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  readonly ifMatch?: number;
}

interface RouteSpec {
  readonly need: Need;
  /** The status an authorized caller gets on a well-formed request. */
  readonly ok: number;
  /** Seeds what the request needs, for a record of `entity`, and returns a request that succeeds. */
  readonly prepare: (entity: Entity) => Promise<Req>;
}

const seedProject = (entity: Entity, over: Record<string, unknown> = {}) =>
  db.project.create({
    data: {
      name: `Project ${entity}`,
      type: "fixed_price",
      entity,
      companyId: "co-acme",
      projectManagerId: "user-pm-ch",
      createdById: "user-pm-ch",
      ...over,
    },
  });

const withProject = async (entity: Entity, over: Record<string, unknown> = {}) => (await seedProject(entity, over)).id;

/** A project made from a deal (terms and purchase order, no project manager) of `entity`; the deal id is unique per entity. */
const withPurchaseOrder = (entity: Entity) =>
  seedDealProject({ project: { entity, name: `PO project ${entity}` }, order: { dealId: `po-deal-${entity}` } });

/** A hand-made project of `entity` with terms. */
const withTerms = async (entity: Entity) => {
  const project = await seedProject(entity);
  await db.projectTerms.create({
    data: {
      projectId: project.id,
      type: "fixed_price",
      startDate: new Date("2026-12-01T00:00:00Z"),
      deadline: new Date("2027-03-31T00:00:00Z"),
      maxEffortManDays: 55.5,
    },
  });
  return project;
};

/** A won deal of `entity` in the fake CRM, with the company the seeded projects have; returns its id. */
const wonDeal = (entity: Entity, over: Partial<Parameters<typeof makeDeal>[0]> = {}): string => {
  const deal = makeDeal({ id: `deal-${entity}`, entity, company: { id: "co-acme", name: "Acme SA" }, ...over });
  crm.deals = [...crm.deals, deal];
  return deal.id;
};

/** The terms of a take or of a terms write, specs/021's contract shape: the dates and the `fixed_price` terms (the deal has no estimate). */
const takeTerms = { startDate: "2027-01-01", terms: { deadline: "2027-06-30", maxEffortManDays: 10 } };
/** The ops-manager each entity has in the fake auth's holders list (test-support/world.ts). */
const OPS_OF: Record<Entity, string> = { welld_ch: "user-ops", welld_it: "user-ops-it" };
const takeBody = (over: Record<string, unknown> = {}) => ({
  name: "Koordy 2027",
  type: "fixed_price",
  terms: takeTerms,
  opsManagerId: "user-ops",
  ...over,
});

const SPECS: Record<string, RouteSpec> = {
  "GET /scope": { need: "access", ok: 200, prepare: async () => ({ method: "GET", path: "/scope" }) },
  "GET /companies": { need: "manage-any", ok: 200, prepare: async () => ({ method: "GET", path: "/companies?q=acme" }) },
  // The to-start queue (specs/022 T24): read by `handoff:take` holders (sales, admin) whole; a take and
  // the take's form (ops-managers, contacts) need `handoff:take` + manage for the DEAL's entity — the CRM,
  // not the request, says which (AC-1.1, AC-1.2, AC-1.9).
  "GET /queue": {
    need: "take-any",
    ok: 200,
    prepare: async (entity) => (wonDeal(entity), { method: "GET", path: "/queue" }),
  },
  "GET /queue/:dealId/ops-managers": {
    need: "take",
    ok: 200,
    prepare: async (entity) => ({ method: "GET", path: `/queue/${wonDeal(entity)}/ops-managers` }),
  },
  "GET /queue/:dealId/contacts": {
    need: "take",
    ok: 200,
    prepare: async (entity) => ({ method: "GET", path: `/queue/${wonDeal(entity)}/contacts` }),
  },
  "POST /queue/:dealId/project": {
    need: "take",
    ok: 201,
    prepare: async (entity) => ({
      method: "POST",
      path: `/queue/${wonDeal(entity)}/project`,
      body: takeBody({ opsManagerId: OPS_OF[entity] }),
    }),
  },
  "GET /project-managers": {
    need: "access",
    ok: 200,
    prepare: async (entity) => (await seedProject(entity), { method: "GET", path: "/project-managers" }),
  },
  "GET /projects": { need: "access", ok: 200, prepare: async (entity) => (await seedProject(entity), { method: "GET", path: "/projects" }) },
  "POST /projects": {
    need: "manage",
    ok: 201,
    prepare: async (entity) => ({ method: "POST", path: "/projects", body: { name: "Koordy", type: "internal", entity } }),
  },
  "GET /projects/:id": {
    need: "access",
    ok: 200,
    prepare: async (entity) => ({ method: "GET", path: `/projects/${await withProject(entity)}` }),
  },
  "PATCH /projects/:id": {
    need: "manage",
    ok: 200,
    prepare: async (entity) => ({ method: "PATCH", path: `/projects/${await withProject(entity)}`, body: { name: "Renamed" }, ifMatch: 1 }),
  },
  "POST /projects/:id/transitions": {
    need: "manage",
    ok: 200,
    prepare: async (entity) => ({
      method: "POST",
      path: `/projects/${await withProject(entity)}/transitions`,
      body: { to: "active" },
      ifMatch: 1,
    }),
  },
  "PUT /projects/:id/team": {
    need: "manage",
    ok: 200,
    prepare: async (entity) => ({
      method: "PUT",
      path: `/projects/${await withProject(entity)}/team`,
      body: { memberIds: ["user-viewer"] },
      ifMatch: 1,
    }),
  },
  "POST /projects/:id/terms": {
    need: "manage",
    ok: 201,
    prepare: async (entity) => ({
      method: "POST",
      path: `/projects/${await withProject(entity)}/terms`,
      body: takeTerms,
    }),
  },
  "PATCH /projects/:id/terms": {
    need: "manage",
    ok: 200,
    prepare: async (entity) => ({
      method: "PATCH",
      path: `/projects/${(await withTerms(entity)).id}/terms`,
      body: { endDate: "2027-06-30" },
      ifMatch: 1,
    }),
  },
  // A hand-made project's terms may be removed; one made from a deal keeps them (`terms_required`).
  "DELETE /projects/:id/terms": {
    need: "manage",
    ok: 204,
    prepare: async (entity) => ({ method: "DELETE", path: `/projects/${(await withTerms(entity)).id}/terms`, ifMatch: 1 }),
  },
  "PUT /projects/:id/purchase-order/bexio-order": {
    need: "bexio",
    ok: 200,
    prepare: async (entity) => {
      const { project } = await withPurchaseOrder(entity);
      return {
        method: "PUT",
        path: `/projects/${project.id}/purchase-order/bexio-order`,
        body: { bexioOrderId: "AB-2026-0042" },
        ifMatch: 1,
      };
    },
  },
  // The referent (specs/022 T26, AC-3.7): `project:manage` for the PROJECT's entity, the company read from its row.
  "GET /projects/:id/purchase-order/contacts": {
    need: "manage",
    ok: 200,
    prepare: async (entity) => ({
      method: "GET",
      path: `/projects/${(await withPurchaseOrder(entity)).project.id}/purchase-order/contacts`,
    }),
  },
  "PATCH /projects/:id/purchase-order": {
    need: "manage",
    ok: 200,
    prepare: async (entity) => ({
      method: "PATCH",
      path: `/projects/${(await withPurchaseOrder(entity)).project.id}/purchase-order`,
      body: { referentContactId: null },
      ifMatch: 1,
    }),
  },
};

/**
 * Second readings of a route a row above already covers, where the same route answers a different
 * question depending on the record or the body: each is driven by the same persona × entity matrix.
 * `route` is the inventory key it belongs to.
 */
const VARIANTS: Record<string, RouteSpec & { readonly route: string }> = {
  // The project-manager pick (specs/022 T27, AC-4.8): a project from a deal awaiting its project manager,
  // whose purchase order names the entity's ops-manager (OPS_OF).
  "PATCH /projects/:id (the pick on an awaiting project)": {
    route: "PATCH /projects/:id",
    need: "pick",
    ok: 200,
    prepare: async (entity) => {
      const { project } = await seedDealProject({
        project: { entity, name: `Awaiting ${entity}` },
        order: { dealId: `pick-deal-${entity}`, opsManagerId: OPS_OF[entity] },
      });
      return { method: "PATCH", path: `/projects/${project.id}`, body: { projectManagerId: "user-pm-ch" }, ifMatch: 1 };
    },
  },
  // A project from a deal is read like any project (AC-3.7: the referent is shown to every holder of access).
  "GET /projects/:id (a project from a deal)": {
    route: "GET /projects/:id",
    need: "access",
    ok: 200,
    prepare: async (entity) => ({ method: "GET", path: `/projects/${(await withPurchaseOrder(entity)).project.id}` }),
  },
  // The awaiting filter of the list is a read.
  "GET /projects (the awaiting filter)": {
    route: "GET /projects",
    need: "access",
    ok: 200,
    prepare: async (entity) => (await withPurchaseOrder(entity), { method: "GET", path: "/projects?projectManagerId=none" }),
  },
};

/** Every row the matrix drives: a route's own row, and its variants. */
const ROWS: Record<string, RouteSpec> = { ...SPECS, ...VARIANTS };

/** The routes that answer without a token: liveness and the API docs. Nothing else may. */
const PUBLIC = new Set(["GET /health", "GET /openapi.json", "GET /docs"]);

/**
 * The service-to-service routes (specs/022): behind a scoped SERVICE credential, never a user JWT, so
 * the persona matrix below does not apply to them. Their credential matrix lives in
 * src/system/*.test.ts; the one thing asserted here is that no user, whatever they hold, opens them.
 */
const SYSTEM = new Set(["GET /system/purchase-orders"]);

const routes = [
  ...new Set(app.routes.filter((route) => route.method !== "ALL").map((route) => `${route.method} ${route.path}`)),
]
  .filter((key) => !PUBLIC.has(key) && !SYSTEM.has(key))
  .sort();

const concrete = (path: string) => path.replace(/:[a-zA-Z]+/g, "some-id");
const split = (key: string): [string, string] => key.split(" ", 2) as [string, string];
const bodyFor = (method: string) => (method === "GET" || method === "DELETE" ? undefined : {});

// ─── What each persona holds (AC-4.2 – AC-4.6), as literals ──────────────────

interface Grants {
  readonly access: boolean;
  readonly manage: readonly Entity[];
  readonly bexio: boolean;
  /** `handoff:take` (specs/022 T24): sales for its own entity, an admin for both. */
  readonly take: readonly Entity[];
  /** `purchase-order:receive` (specs/022 T19): the ops-manager for its own entity, an admin for both. */
  readonly receive: readonly Entity[];
  /** The entities whose seeded purchase order (`OPS_OF`) names this persona as its ops-manager. */
  readonly opsOf: readonly Entity[];
}

// `colleague` (a second reader, for concurrency checks elsewhere) holds what `viewer` holds and is left out.
const GRANTS: Record<Exclude<PersonaName, "colleague">, Grants> = {
  outsider: { access: false, manage: [], bexio: false, take: [], receive: [], opsOf: [] },
  viewer: { access: true, manage: [], bexio: false, take: [], receive: [], opsOf: [] },
  pmCh: { access: true, manage: ["welld_ch"], bexio: false, take: [], receive: [], opsOf: [] },
  salesIt: { access: true, manage: ["welld_it"], bexio: false, take: ["welld_it"], receive: [], opsOf: [] },
  salesCh: { access: true, manage: ["welld_ch"], bexio: false, take: ["welld_ch"], receive: [], opsOf: [] },
  opsCh: { access: true, manage: ["welld_ch"], bexio: false, take: [], receive: ["welld_ch"], opsOf: ["welld_ch"] },
  accounting: { access: true, manage: [], bexio: true, take: [], receive: [], opsOf: [] },
  admin: {
    access: true,
    manage: ["welld_ch", "welld_it"],
    bexio: true,
    take: ["welld_ch", "welld_it"],
    receive: ["welld_ch", "welld_it"],
    opsOf: [],
  },
};
const PERSONA_NAMES = Object.keys(GRANTS) as (keyof typeof GRANTS)[];

type Outcome = "ok" | "forbidden" | "out_of_scope" | "not_ops_manager";

function expectedOutcome(need: Need, grants: Grants, entity: Entity): Outcome {
  if (!grants.access) return "forbidden";
  switch (need) {
    case "access":
      return "ok";
    case "manage-any":
      return grants.manage.length > 0 ? "ok" : "forbidden";
    case "manage":
      if (grants.manage.includes(entity)) return "ok";
      return grants.manage.length > 0 ? "out_of_scope" : "forbidden";
    case "take-any":
      return grants.take.length > 0 ? "ok" : "forbidden";
    case "take":
      if (grants.take.length === 0) return "forbidden";
      return grants.take.includes(entity) && grants.manage.includes(entity) ? "ok" : "out_of_scope";
    case "bexio":
      return grants.bexio ? "ok" : "forbidden";
    case "pick": {
      // The manage gate answers first (`forbidden` / `out_of_scope`); only a manager of the entity is asked
      // whether they may pick: the admin override is `receive` for EVERY entity, an ops-manager's is their own.
      const gate = expectedOutcome("manage", grants, entity);
      if (gate !== "ok") return gate;
      const oversees = ENTITIES.every((each) => grants.receive.includes(each));
      return oversees || (grants.receive.includes(entity) && grants.opsOf.includes(entity)) ? "ok" : "not_ops_manager";
    }
  }
}

/** Every row of the module's tables, in a stable order: a refused request must leave it untouched. */
async function snapshot(): Promise<string> {
  return JSON.stringify([
    await db.project.findMany({ orderBy: { id: "asc" } }),
    await db.projectTerms.findMany({ orderBy: { id: "asc" } }),
    await db.projectTermsPosition.findMany({ orderBy: { id: "asc" } }),
    await db.purchaseOrder.findMany({ orderBy: { id: "asc" } }),
    await db.projectMember.findMany({ orderBy: [{ projectId: "asc" }, { userId: "asc" }] }),
  ]);
}

// ─── The inventory ───────────────────────────────────────────────────────────

describe("authorization matrix: the routes", () => {
  it("has a row for every route the app serves, and no row for a route it does not", () => {
    expect(routes).toEqual(Object.keys(SPECS).sort());
  });

  it("drives its variants through routes it has a row for", () => {
    for (const [name, variant] of Object.entries(VARIANTS)) {
      expect({ name, row: variant.route in SPECS }).toEqual({ name, row: true });
    }
  });

  it("serves the service-to-service routes it lists, and no others", () => {
    const served = [...new Set(app.routes.filter((route) => route.path.startsWith("/system/")).map((route) => `${route.method} ${route.path}`))];
    expect(served.sort()).toEqual([...SYSTEM].sort());
  });

  it("serves liveness and the API docs without a token — and only those", async () => {
    for (const key of PUBLIC) {
      const [method, path] = split(key);
      expect((await app.request(path, { method })).status).toBe(200); // /docs is HTML: no JSON parsing
    }
  });
});

// ─── No token, no access ─────────────────────────────────────────────────────

describe("authorization matrix: before any validation or lookup", () => {
  it.each(routes)("%s: 401 without a token, and with a token that does not verify", async (key) => {
    const [method, path] = split(key);
    const body = bodyFor(method);
    expect((await call(method, concrete(path), { as: null, body })).status).toBe(401);
    const garbage = await app.request(concrete(path), {
      method,
      headers: { Authorization: "Bearer not.a.token", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect(garbage.status).toBe(401);
  });

  it.each(routes)("%s: 403 `forbidden` without projects:access, not a 404 / 400 / 428", async (key) => {
    const [method, path] = split(key);
    const res = await call(method, concrete(path), { as: "outsider", body: bodyFor(method) });
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ status: 403, code: "forbidden" });
  });

  const writes = routes.filter((key) => SPECS[key]?.need !== "access");
  it.each(writes)("%s: a reader without the capability is refused 403 before the record is looked up", async (key) => {
    const [method, path] = split(key);
    // An unknown id and an empty body: a handler that looked first would answer 404 or 400.
    const res = await call(method, concrete(path), { as: "viewer", body: bodyFor(method) });
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "forbidden" });
  });
});

describe("authorization matrix: service-to-service routes", () => {
  it.each([...SYSTEM])("%s: 401 for every user, whatever they hold — a user JWT is not a service credential", async (key) => {
    const [method, path] = split(key);
    for (const persona of PERSONA_NAMES) {
      const res = await call(method, `${path}?dealIds=some-deal`, { as: persona });
      expect({ persona, status: res.status }).toEqual({ persona, status: 401 });
    }
  });
});

// ─── The matrix: every route × persona × the record's entity ─────────────────

describe("authorization matrix: every route × persona × entity", () => {
  for (const [key, spec] of Object.entries(ROWS)) {
    describe(key, () => {
      for (const persona of PERSONA_NAMES) {
        for (const entity of ENTITIES) {
          const outcome = expectedOutcome(spec.need, GRANTS[persona], entity);
          const label = outcome === "ok" ? `${spec.ok}` : `403 ${outcome}`;
          it(`${persona} on a ${entity} record: ${label}`, async () => {
            const req = await spec.prepare(entity);
            const before = await snapshot();
            const res = await call(req.method, req.path, {
              as: persona,
              ...(req.body !== undefined ? { body: req.body } : {}),
              ...(req.ifMatch !== undefined ? { ifMatch: req.ifMatch } : {}),
            });
            if (outcome === "ok") {
              expect(res.status).toBe(spec.ok);
            } else {
              expect(res.status).toBe(403);
              expect(res.json).toMatchObject({ status: 403, code: outcome });
              expect(await snapshot()).toBe(before);
            }
          });
        }
      }
    });
  }
});

// ─── The pieces of the matrix the table cannot say on its own ────────────────

describe("authorization matrix: what holders read (AC-4.3)", () => {
  it("lists the projects of both entities to every holder of access, scoped or not", async () => {
    await seedProject("welld_ch", { name: "Alpha" });
    await seedProject("welld_it", { name: "Beta" });
    for (const persona of PERSONA_NAMES.filter((name) => GRANTS[name].access)) {
      const res = await call("GET", "/projects", { as: persona });
      expect(res.status).toBe(200);
      expect(res.json.total).toBe(2);
      expect(res.json.items.map((item: { name: string }) => item.name)).toEqual(["Alpha", "Beta"]);
    }
  });

  it("refuses the list to a caller without access, whatever else they hold", async () => {
    await seedProject("welld_ch");
    const res = await call("GET", "/projects", { as: "outsider" });
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "forbidden" });
  });
});

describe("authorization matrix: the to-start queue (AC-1.1, AC-1.2, AC-1.9)", () => {
  const queued = async (as: PersonaName): Promise<string[]> =>
    ((await call("GET", "/queue", { as })).json.items as { dealId: string }[]).map((item) => item.dealId).sort();

  it("lists the won deals of both entities to the holders of `handoff:take`, whatever their entity — and refuses everyone else", async () => {
    const ids = [wonDeal("welld_ch"), wonDeal("welld_it")].sort();
    for (const persona of PERSONA_NAMES.filter((name) => GRANTS[name].take.length > 0)) {
      expect({ persona, ids: await queued(persona) }).toEqual({ persona, ids });
    }
    for (const persona of PERSONA_NAMES.filter((name) => GRANTS[name].take.length === 0)) {
      const refused = await call("GET", "/queue", { as: persona });
      expect({ persona, status: refused.status }).toEqual({ persona, status: 403 });
      expect(refused.json).toMatchObject({ code: "forbidden" });
    }
  });

  it("lets only a taker of the deal's entity take it: a refused take leaves the deal queued, the entity's own sales takes it", async () => {
    const deal = wonDeal("welld_ch");
    const body = takeBody();
    for (const persona of ["viewer", "accounting", "pmCh", "opsCh", "salesIt"] as const) {
      const res = await call("POST", `/queue/${deal}/project`, { as: persona, body });
      expect({ persona, status: res.status }).toEqual({ persona, status: 403 });
    }
    expect(await queued("admin")).toEqual([deal]);
    expect((await call("POST", `/queue/${deal}/project`, { as: "salesCh", body })).status).toBe(201);
    expect(await queued("admin")).toEqual([]);
  });

  it("lets an admin take the deal of either entity", async () => {
    for (const entity of ENTITIES) {
      const deal = wonDeal(entity);
      const res = await call("POST", `/queue/${deal}/project`, {
        as: "admin",
        body: takeBody({ name: `Work ${entity}`, opsManagerId: OPS_OF[entity] }),
      });
      expect({ entity, status: res.status }).toEqual({ entity, status: 201 });
      expect(res.json.entity).toBe(entity);
    }
  });
});

describe("authorization matrix: the project-manager pick (AC-4.8, D46, D47, T18 L5)", () => {
  const pick = (id: string, as: PersonaName, projectManagerId = "user-pm-ch", ifMatch = 1) =>
    call("PATCH", `/projects/${id}`, { as, body: { projectManagerId }, ifMatch });
  const projectManagerOf = async (id: string) => (await db.project.findUniqueOrThrow({ where: { id } })).projectManagerId;

  it("refuses an ops-manager who is not the one the purchase order names, and lets an admin pick in their place", async () => {
    const { project } = await seedDealProject({ order: { opsManagerId: "user-ops-elsewhere" } });
    const refused = await pick(project.id, "opsCh");
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ status: 403, code: "not_ops_manager" });
    expect(await projectManagerOf(project.id)).toBeNull();
    expect((await pick(project.id, "admin")).status).toBe(200);
    expect(await projectManagerOf(project.id)).toBe("user-pm-ch");
  });

  it("refuses the person the purchase order names once they no longer hold `purchase-order:receive` (they are a project-manager now)", async () => {
    const { project } = await seedDealProject({ order: { opsManagerId: PERSONAS.pmCh.sub } });
    const refused = await pick(project.id, "pmCh");
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ code: "not_ops_manager" });
    expect(await projectManagerOf(project.id)).toBeNull();
  });

  it("answers `forbidden` to a reader and `out_of_scope` to a manager of the other entity before it asks who the ops-manager is", async () => {
    const { project } = await seedDealProject({ order: { opsManagerId: OPS_OF.welld_ch } });
    for (const [persona, code] of [
      ["viewer", "forbidden"],
      ["accounting", "forbidden"],
      ["salesIt", "out_of_scope"],
    ] as const) {
      const res = await pick(project.id, persona);
      expect({ persona, status: res.status, code: res.json.code }).toEqual({ persona, status: 403, code });
    }
    expect(await projectManagerOf(project.id)).toBeNull();
  });

  it("leaves everything but `projectManagerId` of an awaiting project to any manager of its entity", async () => {
    const { project } = await seedDealProject({ order: { opsManagerId: OPS_OF.welld_ch } });
    const res = await call("PATCH", `/projects/${project.id}`, { as: "pmCh", body: { name: "Renamed by the PM" }, ifMatch: 1 });
    expect(res.status).toBe(200);
    expect(await projectManagerOf(project.id)).toBeNull();
  });

  it("is specs/021's rule once the project has a project manager: any manager of the entity changes it, the ops-manager's pick is over", async () => {
    const id = await withProject("welld_ch");
    let version = 1;
    for (const persona of ["pmCh", "salesCh", "opsCh", "admin"] as const) {
      const res = await pick(id, persona, "user-viewer", version);
      expect({ persona, status: res.status }).toEqual({ persona, status: 200 });
      version++;
    }
    for (const [persona, code] of [
      ["viewer", "forbidden"],
      ["accounting", "forbidden"],
      ["salesIt", "out_of_scope"],
    ] as const) {
      const res = await pick(id, persona, "user-pm-ch", version);
      expect({ persona, status: res.status, code: res.json.code }).toEqual({ persona, status: 403, code });
    }
    expect(await projectManagerOf(id)).toBe("user-viewer");
  });
});

describe("authorization matrix: scope (AC-4.4, AC-4.5, AC-4.6)", () => {
  it("tells each persona what it may manage, so the UI hides what the server would refuse", async () => {
    const scopes = Object.fromEntries(
      await Promise.all(PERSONA_NAMES.filter((name) => GRANTS[name].access).map(async (name) => [name, (await call("GET", "/scope", { as: name })).json])),
    );
    expect(scopes).toEqual({
      viewer: { manage: [], managesAll: false, bexio: false, take: [], oversees: false },
      pmCh: { manage: ["welld_ch"], managesAll: false, bexio: false, take: [], oversees: false },
      salesIt: { manage: ["welld_it"], managesAll: false, bexio: false, take: ["welld_it"], oversees: false },
      salesCh: { manage: ["welld_ch"], managesAll: false, bexio: false, take: ["welld_ch"], oversees: false },
      // `oversees` is `purchase-order:receive` for EVERY entity: an ops-manager has it for its own only.
      opsCh: { manage: ["welld_ch"], managesAll: false, bexio: false, take: [], oversees: false },
      accounting: { manage: [], managesAll: false, bexio: true, take: [], oversees: false },
      admin: { manage: ["welld_ch", "welld_it"], managesAll: true, bexio: true, take: ["welld_ch", "welld_it"], oversees: true },
    });
  });

  it("keeps the matrix honest: the test personas hold what GRANTS says they do", () => {
    // A guard against the two tables drifting apart: the permission rows behind each persona.
    const has = (name: PersonaName, resource: string, action: string) =>
      PERSONAS[name].permissions.some((permission) => permission.resource === resource && permission.action === action);
    // The entities a persona's grant reaches: none without the grant, both when it carries no condition, the
    // persona's own entity when it is entity-scoped.
    const reach = (name: PersonaName, resource: string, action: string): Entity[] => {
      const grant = PERSONAS[name].permissions.find((permission) => permission.resource === resource && permission.action === action);
      if (!grant) return [];
      return grant.conditions === null ? [...ENTITIES] : [PERSONAS[name].entity as Entity];
    };
    for (const name of PERSONA_NAMES) {
      expect(has(name, "projects", "access")).toBe(GRANTS[name].access);
      expect(has(name, "purchase-order", "bexio")).toBe(GRANTS[name].bexio);
      expect({ name, manage: reach(name, "project", "manage") }).toEqual({ name, manage: [...GRANTS[name].manage] });
      expect({ name, take: reach(name, "handoff", "take") }).toEqual({ name, take: [...GRANTS[name].take] });
      expect({ name, receive: reach(name, "purchase-order", "receive") }).toEqual({ name, receive: [...GRANTS[name].receive] });
      // `opsOf` is read off the seed: the ops-manager of an entity's purchase order is the persona with that id.
      expect({ name, opsOf: ENTITIES.filter((entity) => OPS_OF[entity] === PERSONAS[name].sub) }).toEqual({
        name,
        opsOf: [...GRANTS[name].opsOf],
      });
    }
  });
});

// ─── An auth outage is a refusal, never an allow (AC-4.2, ADR-0014) ──────────

describe("authorization matrix: auth outage", () => {
  const subOf = (header: string): string =>
    (JSON.parse(Buffer.from(header.split(".")[1] ?? "", "base64url").toString("utf-8")) as { sub: string }).sub;

  it.each(routes)("%s: 503 `authz_unavailable` when /authz/resolve is down, even for an admin", async (key) => {
    const [method, path] = split(key);
    const harness = setupTestAuth();
    try {
      harness.setResolve(async () => {
        throw new Error("auth down");
      });
      const res = await call(method, concrete(path), { as: "admin", body: bodyFor(method), ifMatch: 1 });
      expect(res.status).toBe(503);
      expect(res.json).toMatchObject({ status: 503, code: "authz_unavailable" });
    } finally {
      // The harness is shared by every file in the process: put the personas back.
      harness.setResolve(async (header) => {
        const sub = subOf(header);
        const persona = Object.values(PERSONAS).find((p) => p.sub === sub)!;
        return { sub, epoch: 0, permissions: persona.permissions, entity: persona.entity, jobTitle: null };
      });
    }
  });

  it("serves again once auth is back", async () => {
    expect((await call("GET", "/scope", { as: "admin" })).status).toBe(200);
  });
});
