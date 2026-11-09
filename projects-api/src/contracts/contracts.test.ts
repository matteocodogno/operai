/**
 * Contracts of a project (specs/024 T8; AC-1.7, AC-2.1 – AC-2.10, AC-4.4). Runs the ASSEMBLED app
 * against the `*_test` database; auth and the CRM are the fakes of test-support/world.ts. Projects
 * are seeded straight in the database (the API under test is not its own fixture).
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { call, crm, db, resetWorld, type PersonaName } from "../test-support/world";
import type { Prisma } from "../lib/generated/prisma/client";

beforeEach(async () => {
  await resetWorld();
  crm.companies = [
    { id: "co-acme", name: "Acme SA", entity: "welld_ch", archived: false },
    { id: "co-zeta", name: "Zeta AG", entity: "welld_it", archived: false },
    { id: "co-old", name: "Legacy Ltd", entity: "welld_ch", archived: true },
  ];
});

type Type = "t_and_m" | "fixed_price" | "maintenance" | "saas" | "internal";

/** A project straight in the database; a client type gets Acme, `saas` and `internal` no company. */
const seed = (type: Type, over: Partial<Prisma.ProjectUncheckedCreateInput> = {}) =>
  db.project.create({
    data: {
      name: `Project ${type}`,
      type,
      entity: "welld_ch",
      companyId: ["saas", "internal"].includes(type) ? null : "co-acme",
      projectManagerId: "user-pm-ch",
      createdById: "user-pm-ch",
      ...over,
    },
  });

const create = (projectId: string, body: unknown, as: PersonaName | null = "pmCh") =>
  call("POST", `/projects/${projectId}/contracts`, { as, body });

const read = (projectId: string, contractId: string, as: PersonaName | null = "viewer") =>
  call("GET", `/projects/${projectId}/contracts/${contractId}`, { as });

const patch = (
  projectId: string,
  contractId: string,
  body: unknown,
  as: PersonaName | null = "pmCh",
  ifMatch: number | string = 1,
) => call("PATCH", `/projects/${projectId}/contracts/${contractId}`, { as, body, ifMatch });

/** The terms each type's contract is created with in these tests. */
const TERMS = {
  fixed_price: { deadline: "2027-03-31", estimatedManDays: 40, maxEffortManDays: 55.5 },
  maintenance: { sla: { highDays: 1, normalDays: 3 }, hourPackage: null },
  saas: { sla: null, hourPackage: null },
  t_and_m: { positions: [{ profile: "Senior developer", plannedManDays: 120 }] },
} as const;

describe("POST /projects/:id/contracts — a contract per project type (AC-2.1, AC-2.3 – AC-2.8)", () => {
  it("creates a fixed price contract: 201, the project's type, origin manual, no Bexio id, the ETag (AC-2.1, AC-2.3)", async () => {
    const project = await seed("fixed_price");
    const res = await create(project.id, { startDate: "2026-12-01", terms: TERMS.fixed_price });
    expect(res.status).toBe(201);
    expect(res.headers.get("ETag")).toBe('"1"');
    expect(res.json).toEqual({
      id: expect.any(String),
      projectId: project.id,
      type: "fixed_price",
      company: { id: "co-acme", name: "Acme SA" },
      origin: "manual",
      dealId: null,
      bexioOrderId: null,
      startDate: "2026-12-01",
      endDate: null,
      terms: { deadline: "2027-03-31", estimatedManDays: 40, maxEffortManDays: 55.5 },
      version: 1,
    });
    expect(await db.contract.findUniqueOrThrow({ where: { id: res.json.id } })).toMatchObject({
      projectId: project.id,
      type: "fixed_price",
      companyId: "co-acme",
      origin: "manual",
    });
  });

  it("creates a maintenance contract with an SLA and an hour package, and a yearly one without expiry (AC-2.4 – AC-2.6)", async () => {
    const project = await seed("maintenance");
    const res = await create(project.id, {
      startDate: "2026-12-01",
      endDate: "2027-11-30",
      terms: {
        sla: { highDays: 1, normalDays: 3 },
        hourPackage: { hours: 80, kind: "capacity", startDate: "2026-12-01", expiryDate: "2027-06-30" },
      },
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      type: "maintenance",
      endDate: "2027-11-30",
      terms: {
        sla: { highDays: 1, normalDays: 3 },
        hourPackage: { hours: 80, kind: "capacity", startDate: "2026-12-01", expiryDate: "2027-06-30" },
      },
    });
    const yearly = await create(project.id, {
      startDate: "2026-12-01",
      terms: { hourPackage: { hours: 120, kind: "yearly", startDate: "2026-12-01" } },
    });
    expect(yearly.status).toBe(201);
    expect(yearly.json.terms).toEqual({
      sla: null,
      hourPackage: { hours: 120, kind: "yearly", startDate: "2026-12-01", expiryDate: null },
    });
  });

  it("creates a T&M contract with its positions, in the order given (AC-2.7)", async () => {
    const project = await seed("t_and_m");
    const res = await create(project.id, {
      startDate: "2026-12-01",
      terms: {
        positions: [
          { profile: "  Senior developer ", plannedManDays: 120 },
          { profile: "Designer", plannedManDays: 12.5 },
        ],
      },
    });
    expect(res.status).toBe(201);
    expect(res.json.terms).toEqual({
      positions: [
        { profile: "Senior developer", plannedManDays: 120 },
        { profile: "Designer", plannedManDays: 12.5 },
      ],
    });
  });

  it("creates a SaaS contract for any CRM company, with neither SLA nor hours (AC-2.2, AC-2.8)", async () => {
    const project = await seed("saas");
    const res = await create(project.id, { companyId: "co-zeta", startDate: "2026-12-01", terms: TERMS.saas });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      type: "saas",
      company: { id: "co-zeta", name: "Zeta AG" },
      terms: { sla: null, hourPackage: null },
    });
    // The licence needs no `terms` member at all when it has neither.
    expect((await create(project.id, { companyId: "co-acme", startDate: "2026-12-01" })).status).toBe(201);
  });
});

describe("GET /projects/:id/contracts/:contractId (AC-2.1, AC-4.3)", () => {
  it("shows the same contract to every holder of access, and the project page lists it as a summary", async () => {
    const project = await seed("fixed_price");
    const created = await create(project.id, { startDate: "2026-12-01", terms: TERMS.fixed_price });
    const res = await read(project.id, created.json.id, "viewer");
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"1"');
    expect(res.json).toEqual(created.json);
    // ContractSummary (T5) is the same facts: what the project page lists is what the contract says.
    const page = await call("GET", `/projects/${project.id}`, { as: "viewer" });
    const { id, type, company, origin, bexioOrderId, startDate, endDate } = res.json;
    expect(page.json.contracts).toEqual([{ id, type, company, origin, bexioOrderId, startDate, endDate }]);
  });

  it("is 404 for an unknown contract, a contract of another project, and an unknown project", async () => {
    const project = await seed("fixed_price");
    const other = await seed("fixed_price", { name: "Other" });
    const created = await create(project.id, { startDate: "2026-12-01", terms: TERMS.fixed_price });
    expect((await read(project.id, "nope")).status).toBe(404);
    expect((await read(other.id, created.json.id)).status).toBe(404);
    expect((await read("nope", created.json.id)).status).toBe(404);
  });

  it("refuses the caller with no module access (403) and no token (401) (AC-4.2)", async () => {
    const project = await seed("fixed_price");
    const created = await create(project.id, { startDate: "2026-12-01", terms: TERMS.fixed_price });
    expect((await read(project.id, created.json.id, "outsider")).status).toBe(403);
    expect((await read(project.id, created.json.id, null)).status).toBe(401);
  });
});

// ─── Terms per type ──────────────────────────────────────────────────────────

const contractCount = () => db.contract.count();

/** One request the API must refuse as a 400 `validation_failed` naming `field`, and store nothing. */
interface Bad {
  readonly what: string;
  readonly type: Type;
  readonly body: Record<string, unknown>;
  readonly field: string;
}
const start = { startDate: "2026-12-01" };
const BAD: readonly Bad[] = [
  // fixed_price (AC-2.3)
  { what: "no terms at all", type: "fixed_price", body: { ...start }, field: "terms.deadline" },
  { what: "no deadline", type: "fixed_price", body: { ...start, terms: { maxEffortManDays: 10 } }, field: "terms.deadline" },
  { what: "no max effort", type: "fixed_price", body: { ...start, terms: { deadline: "2027-01-31" } }, field: "terms.maxEffortManDays" },
  { what: "max effort of zero", type: "fixed_price", body: { ...start, terms: { deadline: "2027-01-31", maxEffortManDays: 0 } }, field: "terms.maxEffortManDays" },
  { what: "max effort with two decimals", type: "fixed_price", body: { ...start, terms: { deadline: "2027-01-31", maxEffortManDays: 10.25 } }, field: "terms.maxEffortManDays" },
  { what: "a negative estimate", type: "fixed_price", body: { ...start, terms: { deadline: "2027-01-31", maxEffortManDays: 10, estimatedManDays: -1 } }, field: "terms.estimatedManDays" },
  { what: "a deadline that is not a date", type: "fixed_price", body: { ...start, terms: { deadline: "2027-02-30", maxEffortManDays: 10 } }, field: "terms.deadline" },
  { what: "a price, which no contract carries", type: "fixed_price", body: { ...start, terms: { deadline: "2027-01-31", maxEffortManDays: 10, price: 5000 } }, field: "terms" },
  { what: "terms that are not an object", type: "fixed_price", body: { ...start, terms: "soon" }, field: "terms" },
  // SLA (AC-2.5), on both types that take one
  { what: "an SLA priority above 60", type: "maintenance", body: { ...start, terms: { sla: { highDays: 61, normalDays: 3 } } }, field: "terms.sla.highDays" },
  { what: "a negative SLA priority", type: "saas", body: { companyId: "co-acme", ...start, terms: { sla: { highDays: 1, normalDays: -1 } } }, field: "terms.sla.normalDays" },
  { what: "a fractional SLA priority", type: "maintenance", body: { ...start, terms: { sla: { highDays: 1.5, normalDays: 3 } } }, field: "terms.sla.highDays" },
  { what: "an SLA with one priority only", type: "maintenance", body: { ...start, terms: { sla: { highDays: 1 } } }, field: "terms.sla.normalDays" },
  // hour package (AC-2.6)
  { what: "zero hours", type: "maintenance", body: { ...start, terms: { hourPackage: { hours: 0, kind: "yearly", startDate: "2026-12-01" } } }, field: "terms.hourPackage.hours" },
  { what: "fractional hours", type: "maintenance", body: { ...start, terms: { hourPackage: { hours: 7.5, kind: "yearly", startDate: "2026-12-01" } } }, field: "terms.hourPackage.hours" },
  { what: "an unknown package kind", type: "maintenance", body: { ...start, terms: { hourPackage: { hours: 10, kind: "monthly", startDate: "2026-12-01" } } }, field: "terms.hourPackage.kind" },
  { what: "a package without a start date", type: "maintenance", body: { ...start, terms: { hourPackage: { hours: 10, kind: "capacity" } } }, field: "terms.hourPackage.startDate" },
  { what: "an expiry on a yearly package", type: "saas", body: { companyId: "co-acme", ...start, terms: { hourPackage: { hours: 10, kind: "yearly", startDate: "2026-12-01", expiryDate: "2027-12-01" } } }, field: "terms.hourPackage.expiryDate" },
  { what: "a capacity package expiring before it starts", type: "maintenance", body: { ...start, terms: { hourPackage: { hours: 10, kind: "capacity", startDate: "2026-12-01", expiryDate: "2026-11-30" } } }, field: "terms.hourPackage.expiryDate" },
  // T&M positions (AC-2.7)
  { what: "no terms at all", type: "t_and_m", body: { ...start }, field: "terms.positions" },
  { what: "no position", type: "t_and_m", body: { ...start, terms: { positions: [] } }, field: "terms.positions" },
  { what: "a position of zero man-days", type: "t_and_m", body: { ...start, terms: { positions: [{ profile: "Dev", plannedManDays: 0 }] } }, field: "terms.positions.0.plannedManDays" },
  { what: "a blank profile", type: "t_and_m", body: { ...start, terms: { positions: [{ profile: "   ", plannedManDays: 5 }] } }, field: "terms.positions.0.profile" },
  { what: "a profile over 120 characters", type: "t_and_m", body: { ...start, terms: { positions: [{ profile: "x".repeat(121), plannedManDays: 5 }] } }, field: "terms.positions.0.profile" },
  { what: "fixed price terms", type: "t_and_m", body: { ...start, terms: { deadline: "2027-01-31", maxEffortManDays: 10 } }, field: "terms.positions" },
  // dates and the envelope (AC-2.1)
  { what: "no start date", type: "fixed_price", body: { terms: TERMS.fixed_price }, field: "startDate" },
  { what: "a start date that is not a date", type: "fixed_price", body: { startDate: "01/12/2026", terms: TERMS.fixed_price }, field: "startDate" },
  { what: "an end before the start", type: "fixed_price", body: { startDate: "2026-12-01", endDate: "2026-11-30", terms: TERMS.fixed_price }, field: "endDate" },
  { what: "a type of its own", type: "fixed_price", body: { ...start, type: "saas", terms: TERMS.fixed_price }, field: "" },
  { what: "a Bexio order id (accounting writes it elsewhere)", type: "fixed_price", body: { ...start, bexioOrderId: "AB-1", terms: TERMS.fixed_price }, field: "" },
];

describe("POST /projects/:id/contracts — validation (AC-2.3 – AC-2.7)", () => {
  it.each(BAD)("refuses $what on $type: 400 naming `$field`, nothing stored", async ({ type, body, field }) => {
    const project = await seed(type);
    const res = await create(project.id, body);
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ status: 400, code: "validation_failed" });
    if (field) expect(res.json.field).toBe(field);
    expect(await contractCount()).toBe(0);
  });

  it("refuses a maintenance contract with neither an SLA nor an hour package: 422 `maintenance_needs_sla_or_hours` (AC-2.4)", async () => {
    const project = await seed("maintenance");
    for (const terms of [undefined, {}, { sla: null, hourPackage: null }]) {
      const res = await create(project.id, { ...start, ...(terms === undefined ? {} : { terms }) });
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ status: 422, code: "maintenance_needs_sla_or_hours" });
    }
    expect(await contractCount()).toBe(0);
  });

  it("accepts the edges: 0-day and 60-day SLA, an estimate of zero, one decimal, a capacity package expiring on its start day", async () => {
    const maintenance = await seed("maintenance");
    const sla = await create(maintenance.id, { ...start, terms: { sla: { highDays: 0, normalDays: 60 } } });
    expect(sla.status).toBe(201);
    expect(sla.json.terms.sla).toEqual({ highDays: 0, normalDays: 60 });
    const sameDay = await create(maintenance.id, {
      ...start,
      terms: { hourPackage: { hours: 1, kind: "capacity", startDate: "2026-12-01", expiryDate: "2026-12-01" } },
    });
    expect(sameDay.status).toBe(201);
    const fixed = await seed("fixed_price", { name: "Fixed" });
    const edge = await create(fixed.id, { ...start, endDate: "2026-12-01", terms: { deadline: "2026-12-01", estimatedManDays: 0, maxEffortManDays: 0.1 } });
    expect(edge.status).toBe(201);
    expect(edge.json).toMatchObject({ endDate: "2026-12-01", terms: { estimatedManDays: 0, maxEffortManDays: 0.1 } });
  });

  it("is `validation_failed` before the project is even looked at only for a malformed envelope; an unknown project is 404", async () => {
    expect((await create("nope", { ...start, terms: TERMS.fixed_price })).status).toBe(404);
  });
});

// ─── What a project takes ────────────────────────────────────────────────────

describe("POST /projects/:id/contracts — which project takes a contract (AC-2.2)", () => {
  it("refuses an internal project: 409 `contracts_not_allowed`", async () => {
    const project = await seed("internal");
    const res = await create(project.id, { companyId: "co-acme", ...start, terms: {} });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ status: 409, code: "contracts_not_allowed" });
    expect(await contractCount()).toBe(0);
  });

  it.each(["closed", "cancelled"] as const)("refuses a %s project: 409 `project_not_open`", async (state) => {
    const project = await seed("fixed_price", { state });
    const res = await create(project.id, { ...start, terms: TERMS.fixed_price });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ status: 409, code: "project_not_open", state });
    expect(await contractCount()).toBe(0);
  });

  it("refuses a contract when the project is closed between the check and the insert (409 `project_not_open`)", async () => {
    const project = await seed("fixed_price", { state: "active" });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    // A concurrent close: it holds the project row, closes it, and commits only after the
    // create has read the (still active) project and is waiting for the row.
    const close = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "project" WHERE "id" = ${project.id} FOR UPDATE`;
        await tx.project.update({ where: { id: project.id }, data: { state: "closed" } });
        locked();
        await held;
      },
      { timeout: 10_000 },
    );
    await lockTaken;
    const pending = create(project.id, { ...start, terms: TERMS.fixed_price });
    await Bun.sleep(200);
    release();
    await close;
    const res = await pending;
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ status: 409, code: "project_not_open", state: "closed" });
    expect(await contractCount()).toBe(0);
  });

  it.each([
    { state: "planned" },
    { state: "active" },
    { state: "on_hold", stateBeforeHold: "active" },
  ] as const)("takes a contract on a $state project", async (over) => {
    const project = await seed("fixed_price", over);
    expect((await create(project.id, { ...start, terms: TERMS.fixed_price })).status).toBe(201);
  });

  it("takes a contract on a client project for its own company only: its own, stated or not, is fine; another is 422 `company_mismatch`", async () => {
    const project = await seed("fixed_price");
    expect((await create(project.id, { companyId: "co-acme", ...start, terms: TERMS.fixed_price })).status).toBe(201);
    const other = await create(project.id, { companyId: "co-zeta", ...start, terms: TERMS.fixed_price });
    expect(other.status).toBe(422);
    expect(other.json).toMatchObject({ code: "company_mismatch", field: "companyId" });
    expect(await contractCount()).toBe(1);
  });

  it("needs no CRM for a client project's contract, and shows the company name as null when the CRM is down", async () => {
    const project = await seed("fixed_price");
    crm.down = true;
    const res = await create(project.id, { ...start, terms: TERMS.fixed_price });
    expect(res.status).toBe(201);
    expect(res.json.company).toEqual({ id: "co-acme", name: null });
  });

  it("takes a SaaS contract for any existing CRM company: a company is required (422 `company_required`), an unknown or archived one is 422 `company_not_found`", async () => {
    const project = await seed("saas");
    const missing = await create(project.id, { ...start, terms: TERMS.saas });
    expect(missing.status).toBe(422);
    expect(missing.json).toMatchObject({ code: "company_required", field: "companyId" });
    for (const companyId of ["co-nope", "co-old"]) {
      const res = await create(project.id, { companyId, ...start, terms: TERMS.saas });
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ code: "company_not_found", field: "companyId" });
    }
    // Two companies of two entities, one project: its clients are the companies of its contracts.
    expect((await create(project.id, { companyId: "co-acme", ...start, terms: TERMS.saas })).status).toBe(201);
    expect((await create(project.id, { companyId: "co-zeta", ...start, terms: TERMS.saas })).status).toBe(201);
    expect(await contractCount()).toBe(2);
  });

  it("is 503 `crm_unavailable` for a SaaS contract when the CRM cannot confirm the company, and stores nothing", async () => {
    const project = await seed("saas");
    crm.down = true;
    const res = await create(project.id, { companyId: "co-acme", ...start, terms: TERMS.saas });
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ code: "crm_unavailable" });
    expect(await contractCount()).toBe(0);
  });

  it("gives every contract its project's type, for every type that takes one (D25)", async () => {
    const bodies = {
      t_and_m: { ...start, terms: TERMS.t_and_m },
      fixed_price: { ...start, terms: TERMS.fixed_price },
      maintenance: { ...start, terms: TERMS.maintenance },
      saas: { companyId: "co-acme", ...start, terms: TERMS.saas },
    } as const;
    for (const type of ["t_and_m", "fixed_price", "maintenance", "saas"] as const) {
      const project = await seed(type, { name: `P ${type}` });
      const res = await create(project.id, bodies[type]);
      expect(res.status).toBe(201);
      expect(res.json.type).toBe(type);
      expect((await db.contract.findUniqueOrThrow({ where: { id: res.json.id } })).type).toBe(type);
    }
  });
});

describe("POST /projects/:id/contracts — who may (AC-4.4)", () => {
  it.each(["viewer", "accounting"] as const)("refuses %s, who manages nothing: 403 `forbidden`, even with a bad body", async (as) => {
    const project = await seed("fixed_price");
    const res = await create(project.id, { ...start, terms: TERMS.fixed_price }, as);
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "forbidden" });
    expect((await create(project.id, { nonsense: true }, as)).status).toBe(403);
    expect(await contractCount()).toBe(0);
  });

  it("refuses the caller with no module access (403) and no token (401) (AC-4.2)", async () => {
    const project = await seed("fixed_price");
    expect((await create(project.id, { ...start, terms: TERMS.fixed_price }, "outsider")).status).toBe(403);
    expect((await create(project.id, { ...start, terms: TERMS.fixed_price }, null)).status).toBe(401);
  });

  it("refuses a manager of the other entity: 403 `out_of_scope`; the entity's own manager and an admin may", async () => {
    const itProject = await seed("fixed_price", { entity: "welld_it" });
    const res = await create(itProject.id, { ...start, terms: TERMS.fixed_price }, "pmCh");
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "out_of_scope" });
    expect(await contractCount()).toBe(0);
    expect((await create(itProject.id, { ...start, terms: TERMS.fixed_price }, "salesIt")).status).toBe(201);
    expect((await create(itProject.id, { ...start, terms: TERMS.fixed_price }, "admin")).status).toBe(201);
  });
});

// ─── Edit and end ────────────────────────────────────────────────────────────

/** A fixed price project with one contract, created through the API. */
async function withContract(type: Type = "fixed_price", over: Partial<Prisma.ProjectUncheckedCreateInput> = {}) {
  const project = await seed(type, over);
  const bodies = {
    fixed_price: { ...start, terms: TERMS.fixed_price },
    maintenance: { ...start, terms: TERMS.maintenance },
    t_and_m: { ...start, terms: TERMS.t_and_m },
    saas: { companyId: "co-acme", ...start, terms: TERMS.saas },
    internal: {},
  } as const;
  // An admin manages both entities, so the fixture does not depend on who is under test.
  const res = await create(project.id, bodies[type], "admin");
  expect(res.status).toBe(201);
  return { project, contract: res.json as { id: string } };
}

describe("PATCH /projects/:id/contracts/:contractId — dates and terms (AC-2.1, AC-2.3 – AC-2.7, AC-1.7)", () => {
  it("changes the dates: 200, the new ETag and version, stored", async () => {
    const { project, contract } = await withContract();
    const res = await patch(project.id, contract.id, { startDate: "2026-12-15", endDate: "2027-06-30" });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"2"');
    expect(res.json).toMatchObject({ id: contract.id, startDate: "2026-12-15", endDate: "2027-06-30", version: 2 });
    expect(await db.contract.findUniqueOrThrow({ where: { id: contract.id } })).toMatchObject({ version: 2 });
    // The terms were not part of the edit.
    expect(res.json.terms).toEqual({ deadline: "2027-03-31", estimatedManDays: 40, maxEffortManDays: 55.5 });
  });

  it("ends a contract by setting its end date, which the project page shows as its end date; `null` reopens it (AC-2.10, AC-1.5)", async () => {
    const { project, contract } = await withContract();
    const ended = await patch(project.id, contract.id, { endDate: "2027-01-31" });
    expect(ended.status).toBe(200);
    expect(ended.json.endDate).toBe("2027-01-31");
    const page = await call("GET", `/projects/${project.id}`, { as: "viewer" });
    expect(page.json).toMatchObject({ startDate: "2026-12-01", endDate: "2027-01-31" });
    const reopened = await patch(project.id, contract.id, { endDate: null }, "pmCh", 2);
    expect(reopened.status).toBe(200);
    expect(reopened.json.endDate).toBeNull();
  });

  it("may end a contract of a closed project (only NEW contracts are refused there)", async () => {
    const { project, contract } = await withContract();
    await db.project.update({ where: { id: project.id }, data: { state: "closed" } });
    expect((await patch(project.id, contract.id, { endDate: "2027-01-31" })).status).toBe(200);
  });

  it("replaces fixed price terms whole", async () => {
    const { project, contract } = await withContract();
    const res = await patch(project.id, contract.id, { terms: { deadline: "2027-09-01", maxEffortManDays: 70 } });
    expect(res.status).toBe(200);
    expect(res.json.terms).toEqual({ deadline: "2027-09-01", estimatedManDays: null, maxEffortManDays: 70 });
  });

  it("replaces maintenance terms whole: dropping the SLA clears it, an hour package arrives with its dates (AC-2.4 – AC-2.6)", async () => {
    const { project, contract } = await withContract("maintenance");
    const res = await patch(project.id, contract.id, {
      terms: { hourPackage: { hours: 200, kind: "capacity", startDate: "2027-01-01", expiryDate: "2027-12-31" } },
    });
    expect(res.status).toBe(200);
    expect(res.json.terms).toEqual({
      sla: null,
      hourPackage: { hours: 200, kind: "capacity", startDate: "2027-01-01", expiryDate: "2027-12-31" },
    });
    expect(await db.contract.findUniqueOrThrow({ where: { id: contract.id } })).toMatchObject({
      slaHighDays: null,
      slaNormalDays: null,
      hourPackageKind: "capacity",
    });
    // A yearly package replacing a capacity one leaves no stale expiry behind.
    const yearly = await patch(project.id, contract.id, { terms: { hourPackage: { hours: 50, kind: "yearly", startDate: "2027-01-01" } } }, "pmCh", 2);
    expect(yearly.json.terms.hourPackage).toEqual({ hours: 50, kind: "yearly", startDate: "2027-01-01", expiryDate: null });
  });

  it("refuses to strip a maintenance contract of both its SLA and its hours: 422, unchanged (AC-2.4)", async () => {
    const { project, contract } = await withContract("maintenance");
    const res = await patch(project.id, contract.id, { terms: { sla: null, hourPackage: null } });
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ code: "maintenance_needs_sla_or_hours" });
    expect(await db.contract.findUniqueOrThrow({ where: { id: contract.id } })).toMatchObject({ slaHighDays: 1, version: 1 });
  });

  it("lets a SaaS licence drop both SLA and hours (AC-2.8)", async () => {
    const { project, contract } = await withContract("saas");
    const withSla = await patch(project.id, contract.id, { terms: { sla: { highDays: 2, normalDays: 5 } } });
    expect(withSla.json.terms).toEqual({ sla: { highDays: 2, normalDays: 5 }, hourPackage: null });
    const bare = await patch(project.id, contract.id, { terms: {} }, "pmCh", 2);
    expect(bare.status).toBe(200);
    expect(bare.json.terms).toEqual({ sla: null, hourPackage: null });
  });

  it("replaces a T&M contract's positions, in the order given; never down to none (AC-2.7)", async () => {
    const { project, contract } = await withContract("t_and_m");
    const res = await patch(project.id, contract.id, {
      terms: { positions: [{ profile: "Tester", plannedManDays: 10 }, { profile: "PM", plannedManDays: 5.5 }, { profile: "Dev", plannedManDays: 90 }] },
    });
    expect(res.status).toBe(200);
    expect(res.json.terms.positions.map((p: { profile: string }) => p.profile)).toEqual(["Tester", "PM", "Dev"]);
    expect(await db.contractPosition.count({ where: { contractId: contract.id } })).toBe(3);
    const none = await patch(project.id, contract.id, { terms: { positions: [] } }, "pmCh", 2);
    expect(none.status).toBe(400);
    expect(none.json).toMatchObject({ code: "validation_failed", field: "terms.positions" });
    expect(await db.contractPosition.count({ where: { contractId: contract.id } })).toBe(3);
  });

  it("validates terms against the contract's own type: positions on a fixed price contract is 400, and nothing changes", async () => {
    const { project, contract } = await withContract();
    const res = await patch(project.id, contract.id, { terms: { positions: [{ profile: "Dev", plannedManDays: 1 }] } });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: "validation_failed" });
    expect((await db.contract.findUniqueOrThrow({ where: { id: contract.id } })).version).toBe(1);
  });

  it("refuses dates out of order, against the stored one too: 400", async () => {
    const { project, contract } = await withContract();
    await patch(project.id, contract.id, { endDate: "2027-03-01" });
    const early = await patch(project.id, contract.id, { endDate: "2026-11-30" }, "pmCh", 2);
    expect(early.status).toBe(400);
    expect(early.json).toMatchObject({ code: "validation_failed", field: "endDate" });
    const late = await patch(project.id, contract.id, { startDate: "2027-03-02" }, "pmCh", 2);
    expect(late.status).toBe(400);
    expect(late.json).toMatchObject({ code: "validation_failed", field: "startDate" });
    const both = await patch(project.id, contract.id, { startDate: "2027-05-01", endDate: "2027-04-01" }, "pmCh", 2);
    expect(both.status).toBe(400);
    expect((await db.contract.findUniqueOrThrow({ where: { id: contract.id } })).version).toBe(2);
  });

  it.each([
    { what: "an empty body", body: {} },
    { what: "a type", body: { type: "saas" } },
    { what: "a company", body: { companyId: "co-zeta" } },
    { what: "a Bexio order id", body: { bexioOrderId: "AB-1" } },
  ])("refuses $what: 400", async ({ body }) => {
    const { project, contract } = await withContract();
    const res = await patch(project.id, contract.id, body);
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: "validation_failed" });
  });

  it("leaves the Bexio order id alone", async () => {
    const { project, contract } = await withContract();
    await db.contract.update({ where: { id: contract.id }, data: { bexioOrderId: "AB-1" } });
    const res = await patch(project.id, contract.id, { endDate: "2027-01-31" });
    expect(res.json.bexioOrderId).toBe("AB-1");
  });

  it("is 428 without `If-Match` and 409 `version_conflict` with the current version for a stale one (AC-1.7)", async () => {
    const { project, contract } = await withContract();
    const none = await call("PATCH", `/projects/${project.id}/contracts/${contract.id}`, { as: "pmCh", body: { endDate: "2027-01-31" } });
    expect(none.status).toBe(428);
    expect(none.json).toMatchObject({ code: "precondition_required" });
    expect((await patch(project.id, contract.id, { endDate: "2027-01-31" }, "pmCh", "W/\"1\"")).status).toBe(428);
    await patch(project.id, contract.id, { endDate: "2027-01-31" });
    const stale = await patch(project.id, contract.id, { endDate: "2027-02-28" });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ status: 409, code: "version_conflict", currentVersion: 2 });
    expect((await db.contract.findUniqueOrThrow({ where: { id: contract.id } })).endDate?.toISOString().slice(0, 10)).toBe("2027-01-31");
  });

  it("lets exactly one of two simultaneous saves of the same version win (AC-1.7)", async () => {
    const { project, contract } = await withContract();
    const [a, b] = await Promise.all([
      patch(project.id, contract.id, { endDate: "2027-01-31" }),
      patch(project.id, contract.id, { endDate: "2027-02-28" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await db.contract.findUniqueOrThrow({ where: { id: contract.id } })).version).toBe(2);
  });

  it("is 404 for an unknown contract, one of another project, and an unknown project", async () => {
    const { project, contract } = await withContract();
    const other = await seed("fixed_price", { name: "Other" });
    expect((await patch(project.id, "nope", { endDate: "2027-01-31" })).status).toBe(404);
    expect((await patch(other.id, contract.id, { endDate: "2027-01-31" })).status).toBe(404);
    expect((await patch("nope", contract.id, { endDate: "2027-01-31" })).status).toBe(404);
  });

  it.each(["viewer", "accounting"] as const)("refuses %s: 403 `forbidden`, even with a bad body (AC-4.4)", async (as) => {
    const { project, contract } = await withContract();
    expect((await patch(project.id, contract.id, { endDate: "2027-01-31" }, as)).status).toBe(403);
    expect((await patch(project.id, contract.id, {}, as)).status).toBe(403);
    expect((await db.contract.findUniqueOrThrow({ where: { id: contract.id } })).version).toBe(1);
  });

  it("refuses no module access (403), no token (401), and a manager of the other entity (403 `out_of_scope`)", async () => {
    const { project, contract } = await withContract("fixed_price", { entity: "welld_it" });
    expect((await patch(project.id, contract.id, { endDate: "2027-01-31" }, "outsider")).status).toBe(403);
    expect((await patch(project.id, contract.id, { endDate: "2027-01-31" }, null)).status).toBe(401);
    const res = await patch(project.id, contract.id, { endDate: "2027-01-31" }, "pmCh");
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "out_of_scope" });
    expect((await patch(project.id, contract.id, { endDate: "2027-01-31" }, "salesIt")).status).toBe(200);
  });
});

// ─── Never delete ────────────────────────────────────────────────────────────

describe("DELETE /projects/:id/contracts/:contractId (AC-2.10, D34)", () => {
  it.each(["pmCh", "admin", "viewer"] as const)("is 405 `not_deletable` for %s, and the contract stays", async (as) => {
    const { project, contract } = await withContract();
    const res = await call("DELETE", `/projects/${project.id}/contracts/${contract.id}`, { as });
    expect(res.status).toBe(405);
    expect(res.json).toMatchObject({ status: 405, code: "not_deletable" });
    expect(await db.contract.count({ where: { id: contract.id } })).toBe(1);
  });

  it("still asks who you are: 401 without a token, 403 without module access", async () => {
    const { project, contract } = await withContract();
    expect((await call("DELETE", `/projects/${project.id}/contracts/${contract.id}`, { as: null })).status).toBe(401);
    expect((await call("DELETE", `/projects/${project.id}/contracts/${contract.id}`, { as: "outsider" })).status).toBe(403);
  });

  it("cannot be deleted by deleting the project either: the database restricts it", async () => {
    const { project } = await withContract();
    await expect((async () => db.project.delete({ where: { id: project.id } }))()).rejects.toThrow();
    expect(await contractCount()).toBe(1);
  });
});

// ─── No money ────────────────────────────────────────────────────────────────

describe("no amount anywhere (AC-2.9, D14)", () => {
  /** Every key of a JSON document, at any depth. */
  const keysOf = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.flatMap(keysOf)
      : value && typeof value === "object"
        ? Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)])
        : [];
  const MONEY = /price|rate|amount|fee|budget|cost|salary|currency|chf|eur|money|invoice/i;

  it("carries no money member in a contract of any type, nor on the project page that lists them", async () => {
    for (const type of ["fixed_price", "maintenance", "t_and_m", "saas"] as const) {
      const { project, contract } = await withContract(type, { name: `P ${type}` });
      const read1 = await read(project.id, contract.id);
      const page = await call("GET", `/projects/${project.id}`, { as: "viewer" });
      for (const keys of [keysOf(read1.json), keysOf(page.json)]) {
        expect(keys.filter((key) => MONEY.test(key))).toEqual([]);
      }
      // The check is not vacuous: it sees the keys that ARE there.
      expect(keysOf(read1.json)).toContain("terms");
    }
  });
});
