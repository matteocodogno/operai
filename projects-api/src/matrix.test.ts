/**
 * Authorization matrix over the ASSEMBLED app (specs/024-projects T10; AC-4.2 – AC-4.6, ADR-0014).
 *
 * The route list is read from the app's own table, so a route added without a row here fails the
 * inventory test, and one added without a guard fails the matrix. Every route is then driven by
 * every persona against a record of each entity:
 *
 *   outsider    no grant of the module (an `employee`, AC-4.6)         -> 403 `forbidden` everywhere
 *   viewer      `projects:access` only                                   -> reads, manages nothing (AC-4.3)
 *   pmCh        `project-manager` in welld_ch: manage, entity-scoped     -> own entity only (AC-4.4)
 *   salesIt     `sales` in welld_it: manage, entity-scoped               -> own entity only (AC-4.4)
 *   accounting  `projects:access` + `contract:bexio`                     -> reads, writes the Bexio id (AC-4.5)
 *   admin       everything, unscoped                                     -> both entities (AC-4.6)
 *
 * What each persona holds is written out below as literals (the spec's grants), NOT computed from
 * the test-support personas or from the guards under test. A refused write must also change
 * nothing: the database is compared before and after.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { setupTestAuth } from "./test-support/testAuth";
import { PERSONAS, app, call, crm, db, resetWorld, type PersonaName } from "./test-support/world";

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
 *   bexio        `contract:bexio`, not entity-scoped
 */
type Need = "access" | "manage-any" | "manage" | "bexio";

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

const seedContract = (projectId: string) =>
  db.contract.create({
    data: {
      projectId,
      type: "fixed_price",
      companyId: "co-acme",
      startDate: new Date("2026-12-01T00:00:00Z"),
      deadline: new Date("2027-03-31T00:00:00Z"),
      maxEffortManDays: 55.5,
    },
  });

const withProject = async (entity: Entity, over: Record<string, unknown> = {}) => (await seedProject(entity, over)).id;

const withContract = async (entity: Entity) => {
  const project = await seedProject(entity);
  return { project, contract: await seedContract(project.id) };
};

const SPECS: Record<string, RouteSpec> = {
  "GET /scope": { need: "access", ok: 200, prepare: async () => ({ method: "GET", path: "/scope" }) },
  "GET /companies": { need: "manage-any", ok: 200, prepare: async () => ({ method: "GET", path: "/companies?q=acme" }) },
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
  "PUT /projects/:id/type": {
    need: "manage",
    ok: 200,
    prepare: async (entity) => ({
      method: "PUT",
      path: `/projects/${await withProject(entity, { type: "internal", companyId: null })}/type`,
      body: { type: "saas" },
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
  "POST /projects/:id/contracts": {
    need: "manage",
    ok: 201,
    prepare: async (entity) => ({
      method: "POST",
      path: `/projects/${await withProject(entity)}/contracts`,
      body: { startDate: "2027-01-01", terms: { deadline: "2027-06-30", maxEffortManDays: 10 } },
    }),
  },
  "GET /projects/:id/contracts/:contractId": {
    need: "access",
    ok: 200,
    prepare: async (entity) => {
      const { project, contract } = await withContract(entity);
      return { method: "GET", path: `/projects/${project.id}/contracts/${contract.id}` };
    },
  },
  "PATCH /projects/:id/contracts/:contractId": {
    need: "manage",
    ok: 200,
    prepare: async (entity) => {
      const { project, contract } = await withContract(entity);
      return { method: "PATCH", path: `/projects/${project.id}/contracts/${contract.id}`, body: { endDate: "2027-06-30" }, ifMatch: 1 };
    },
  },
  // Guarded by access alone, then refused for everyone: a contract is never deleted, it ends (D34).
  "DELETE /projects/:id/contracts/:contractId": {
    need: "access",
    ok: 405,
    prepare: async (entity) => {
      const { project, contract } = await withContract(entity);
      return { method: "DELETE", path: `/projects/${project.id}/contracts/${contract.id}` };
    },
  },
  "PUT /projects/:id/contracts/:contractId/bexio-order": {
    need: "bexio",
    ok: 200,
    prepare: async (entity) => {
      const { project, contract } = await withContract(entity);
      return {
        method: "PUT",
        path: `/projects/${project.id}/contracts/${contract.id}/bexio-order`,
        body: { bexioOrderId: "AB-2026-0042" },
        ifMatch: 1,
      };
    },
  },
};

/** The routes that answer without a token: liveness and the API docs. Nothing else may. */
const PUBLIC = new Set(["GET /health", "GET /openapi.json", "GET /docs"]);

const routes = [
  ...new Set(app.routes.filter((route) => route.method !== "ALL").map((route) => `${route.method} ${route.path}`)),
]
  .filter((key) => !PUBLIC.has(key))
  .sort();

const concrete = (path: string) => path.replace(/:[a-zA-Z]+/g, "some-id");
const split = (key: string): [string, string] => key.split(" ", 2) as [string, string];
const bodyFor = (method: string) => (method === "GET" || method === "DELETE" ? undefined : {});

// ─── What each persona holds (AC-4.2 – AC-4.6), as literals ──────────────────

interface Grants {
  readonly access: boolean;
  readonly manage: readonly Entity[];
  readonly bexio: boolean;
}

const GRANTS: Record<Exclude<PersonaName, "colleague">, Grants> = {
  outsider: { access: false, manage: [], bexio: false },
  viewer: { access: true, manage: [], bexio: false },
  pmCh: { access: true, manage: ["welld_ch"], bexio: false },
  salesIt: { access: true, manage: ["welld_it"], bexio: false },
  accounting: { access: true, manage: [], bexio: true },
  admin: { access: true, manage: ["welld_ch", "welld_it"], bexio: true },
};
const PERSONA_NAMES = Object.keys(GRANTS) as (keyof typeof GRANTS)[];

type Outcome = "ok" | "forbidden" | "out_of_scope";

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
    case "bexio":
      return grants.bexio ? "ok" : "forbidden";
  }
}

/** Every row of the module's tables, in a stable order: a refused request must leave it untouched. */
async function snapshot(): Promise<string> {
  return JSON.stringify([
    await db.project.findMany({ orderBy: { id: "asc" } }),
    await db.contract.findMany({ orderBy: { id: "asc" } }),
    await db.contractPosition.findMany({ orderBy: { id: "asc" } }),
    await db.projectMember.findMany({ orderBy: [{ projectId: "asc" }, { userId: "asc" }] }),
  ]);
}

// ─── The inventory ───────────────────────────────────────────────────────────

describe("authorization matrix: the routes", () => {
  it("has a row for every route the app serves, and no row for a route it does not", () => {
    expect(routes).toEqual(Object.keys(SPECS).sort());
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

// ─── The matrix: every route × persona × the record's entity ─────────────────

describe("authorization matrix: every route × persona × entity", () => {
  for (const [key, spec] of Object.entries(SPECS)) {
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

describe("authorization matrix: scope (AC-4.4, AC-4.5, AC-4.6)", () => {
  it("tells each persona what it may manage, so the UI hides what the server would refuse", async () => {
    const scopes = Object.fromEntries(
      await Promise.all(PERSONA_NAMES.filter((name) => GRANTS[name].access).map(async (name) => [name, (await call("GET", "/scope", { as: name })).json])),
    );
    expect(scopes).toEqual({
      viewer: { manage: [], managesAll: false, bexio: false },
      pmCh: { manage: ["welld_ch"], managesAll: false, bexio: false },
      salesIt: { manage: ["welld_it"], managesAll: false, bexio: false },
      accounting: { manage: [], managesAll: false, bexio: true },
      admin: { manage: ["welld_ch", "welld_it"], managesAll: true, bexio: true },
    });
  });

  it("keeps the matrix honest: the test personas hold what GRANTS says they do", () => {
    // A guard against the two tables drifting apart: the permission rows behind each persona.
    const has = (name: PersonaName, resource: string, action: string) =>
      PERSONAS[name].permissions.some((permission) => permission.resource === resource && permission.action === action);
    for (const name of PERSONA_NAMES) {
      expect(has(name, "projects", "access")).toBe(GRANTS[name].access);
      expect(has(name, "project", "manage")).toBe(GRANTS[name].manage.length > 0);
      expect(has(name, "contract", "bexio")).toBe(GRANTS[name].bexio);
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
