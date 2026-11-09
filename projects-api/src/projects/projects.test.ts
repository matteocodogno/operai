/**
 * Projects: create, list, read, rename / change project manager (specs/024 T5;
 * AC-1.1, AC-1.4, AC-1.5, AC-1.6, AC-1.7, AC-4.3, AC-4.4). Runs the ASSEMBLED app against the
 * `*_test` database; auth, the identity service and crm-api are the fakes of
 * test-support/world.ts.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { appAccess, call, crm, db, identities, resetWorld, type PersonaName } from "../test-support/world";
import type { Prisma } from "../lib/generated/prisma/client";

const CLIENT_TYPES = ["t_and_m", "fixed_price", "maintenance"] as const;

beforeEach(async () => {
  await resetWorld();
  crm.companies = [
    { id: "co-acme", name: "Acme SA", entity: "welld_ch", archived: false },
    { id: "co-zeta", name: "Zeta AG", entity: "welld_it", archived: false },
    { id: "co-old", name: "Legacy Ltd", entity: "welld_ch", archived: true },
  ];
});

const create = (body: Record<string, unknown>, as: PersonaName | null = "pmCh") =>
  call("POST", "/projects", { as, body });

const date = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** A project straight in the database (the API under test is not its own fixture). */
const seed = (over: Partial<Prisma.ProjectUncheckedCreateInput> = {}) =>
  db.project.create({
    data: {
      name: "Koordy",
      type: "t_and_m",
      entity: "welld_ch",
      companyId: "co-acme",
      projectManagerId: "user-pm-ch",
      createdById: "user-pm-ch",
      ...over,
    },
  });

/** A contract straight in the database; only the columns the project view reads. */
const seedContract = (
  projectId: string,
  over: Partial<Prisma.ContractUncheckedCreateInput> & { type?: Prisma.ContractUncheckedCreateInput["type"] } = {},
) =>
  db.contract.create({
    data: { projectId, type: "t_and_m", companyId: "co-acme", startDate: date("2026-01-01"), ...over },
  });

describe("POST /projects", () => {
  it("creates a client project: planned, 201 with the Project shape, an ETag and the company's live name (AC-1.1)", async () => {
    const res = await create({ name: "  Koordy  ", type: "t_and_m", entity: "welld_ch", companyId: "co-acme" });
    expect(res.status).toBe(201);
    expect(res.headers.get("ETag")).toBe('"1"');
    expect(res.json).toEqual({
      id: expect.any(String),
      name: "Koordy",
      type: "t_and_m",
      state: "planned",
      stateBeforeHold: null,
      entity: "welld_ch",
      company: { id: "co-acme", name: "Acme SA" },
      projectManager: { id: "user-pm-ch", name: "Name of user-pm-ch", deleted: false },
      team: [],
      contracts: [],
      startDate: null,
      endDate: null,
      version: 1,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    const stored = await db.project.findUniqueOrThrow({ where: { id: res.json.id } });
    expect(stored).toMatchObject({ createdById: "user-pm-ch", companyId: "co-acme", state: "planned" });
  });

  it.each(["saas", "internal"] as const)("creates a %s project without a company (AC-1.1)", async (type) => {
    const res = await create({ name: "Koordy", type, entity: "welld_ch" });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ type, company: null });
  });

  it.each(CLIENT_TYPES)("refuses a %s project without a company: 422 `company_required` (AC-1.1)", async (type) => {
    const res = await create({ name: "Koordy", type, entity: "welld_ch" });
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ status: 422, code: "company_required" });
    expect(await db.project.count()).toBe(0);
  });

  it.each(["saas", "internal"] as const)("refuses a %s project with a company: 422 `company_not_allowed`", async (type) => {
    const res = await create({ name: "Koordy", type, entity: "welld_ch", companyId: "co-acme" });
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ code: "company_not_allowed" });
    expect(await db.project.count()).toBe(0);
  });

  it("refuses a company the CRM does not know, or has archived: 422 `company_not_found`", async () => {
    const unknown = await create({ name: "Koordy", type: "t_and_m", entity: "welld_ch", companyId: "co-nope" });
    expect(unknown.status).toBe(422);
    expect(unknown.json).toMatchObject({ code: "company_not_found" });
    const archived = await create({ name: "Koordy", type: "t_and_m", entity: "welld_ch", companyId: "co-old" });
    expect(archived.status).toBe(422);
    expect(archived.json).toMatchObject({ code: "company_not_found" });
    expect(await db.project.count()).toBe(0);
  });

  it("is 503 `crm_unavailable` when the company cannot be checked, but a project without one needs no CRM", async () => {
    crm.down = true;
    const withCompany = await create({ name: "Koordy", type: "t_and_m", entity: "welld_ch", companyId: "co-acme" });
    expect(withCompany.status).toBe(503);
    expect(withCompany.json).toMatchObject({ code: "crm_unavailable" });
    expect(await db.project.count()).toBe(0);
    expect((await create({ name: "Tools", type: "internal", entity: "welld_ch" })).status).toBe(201);
  });

  it("lets a manager create in their own entity, and an admin in either (AC-4.4, AC-4.6)", async () => {
    expect((await create({ name: "Tools", type: "internal", entity: "welld_ch" }, "pmCh")).status).toBe(201);
    expect((await create({ name: "Tools", type: "internal", entity: "welld_it" }, "salesIt")).status).toBe(201);
    expect((await create({ name: "Tools", type: "internal", entity: "welld_ch" }, "admin")).status).toBe(201);
    expect((await create({ name: "Tools", type: "internal", entity: "welld_it" }, "admin")).status).toBe(201);
  });

  it("refuses the other entity: 403 `out_of_scope`, and creates nothing (AC-4.4)", async () => {
    const pm = await create({ name: "Tools", type: "internal", entity: "welld_it" }, "pmCh");
    expect(pm.status).toBe(403);
    expect(pm.json).toMatchObject({ status: 403, code: "out_of_scope" });
    const sales = await create({ name: "Tools", type: "internal", entity: "welld_ch" }, "salesIt");
    expect(sales.status).toBe(403);
    expect(sales.json).toMatchObject({ code: "out_of_scope" });
    expect(await db.project.count()).toBe(0);
  });

  it.each(["viewer", "accounting"] as const)("refuses %s, who manages nothing: 403 `forbidden` (AC-4.3)", async (as) => {
    const res = await create({ name: "Tools", type: "internal", entity: "welld_ch" }, as);
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "forbidden" });
  });

  it("refuses the caller with no module access (403) and no token (401), even with a bad body (AC-4.2)", async () => {
    expect((await create({ name: "Tools", type: "internal", entity: "welld_ch" }, "outsider")).status).toBe(403);
    expect((await create({ name: "Tools", type: "internal", entity: "welld_ch" }, null)).status).toBe(401);
    expect((await create({}, "viewer")).status).toBe(403);
  });

  it("gives the project to another project-module user as its manager, named live (AC-1.1, AC-1.6)", async () => {
    const res = await create({ name: "Koordy", type: "internal", entity: "welld_ch", projectManagerId: "user-colleague" });
    expect(res.status).toBe(201);
    expect(res.json.projectManager).toEqual({ id: "user-colleague", name: "Name of user-colleague", deleted: false });
    expect(await db.project.findUniqueOrThrow({ where: { id: res.json.id } })).toMatchObject({
      projectManagerId: "user-colleague",
      createdById: "user-pm-ch",
    });
  });

  it("refuses a project manager without module access: 422 `not_project_user` naming the id (AC-1.6)", async () => {
    const res = await create({ name: "Koordy", type: "internal", entity: "welld_ch", projectManagerId: "user-employee" });
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ status: 422, code: "not_project_user", userIds: ["user-employee"] });
    expect(await db.project.count()).toBe(0);
  });

  it("refuses a project manager whose access was revoked since the token was issued (checked live)", async () => {
    appAccess.projects.delete("user-colleague");
    const res = await create({ name: "Koordy", type: "internal", entity: "welld_ch", projectManagerId: "user-colleague" });
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ code: "not_project_user", userIds: ["user-colleague"] });
  });

  it("is 503 when auth cannot say whether the project manager has access, never an allow (AC-1.6)", async () => {
    identities.down = true;
    const res = await create({ name: "Koordy", type: "internal", entity: "welld_ch", projectManagerId: "user-colleague" });
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ status: 503, code: "identity_unavailable" });
    expect(await db.project.count()).toBe(0);
  });

  it("needs no identity check when the caller is the project manager, even with auth degraded", async () => {
    identities.down = true;
    const res = await create({ name: "Koordy", type: "internal", entity: "welld_ch" });
    expect(res.status).toBe(201);
    // The name is fail-soft: unknown while auth cannot answer.
    expect(res.json.projectManager).toEqual({ id: "user-pm-ch", name: null, deleted: false });
  });

  it.each([
    ["a blank name", { name: "   ", type: "internal", entity: "welld_ch" }, "name"],
    ["an unknown type", { name: "Koordy", type: "retainer", entity: "welld_ch" }, "type"],
    ["an unknown entity", { name: "Koordy", type: "internal", entity: "welld_de" }, "entity"],
    ["a name over 200 characters", { name: "x".repeat(201), type: "internal", entity: "welld_ch" }, "name"],
    ["a state of the caller's choosing", { name: "Koordy", type: "internal", entity: "welld_ch", state: "active" }, ""],
  ])("is 400 `validation_failed` for %s", async (_label, body, field) => {
    const res = await create(body);
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ status: 400, code: "validation_failed", field });
  });
});

describe("GET /projects/:id", () => {
  it("shows every access holder the project with live names, its team and its contracts (AC-1.5, AC-4.3)", async () => {
    const project = await seed({ type: "saas", companyId: null, projectManagerId: "user-gone" });
    await db.projectMember.createMany({
      data: [
        { projectId: project.id, userId: "user-colleague" },
        { projectId: project.id, userId: "user-viewer" },
      ],
    });
    await seedContract(project.id, { type: "saas", companyId: "co-zeta", startDate: date("2026-03-01"), bexioOrderId: "ORD-7" });
    const res = await call("GET", `/projects/${project.id}`, { as: "viewer" });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"1"');
    expect(res.json).toEqual({
      id: project.id,
      name: "Koordy",
      type: "saas",
      state: "planned",
      stateBeforeHold: null,
      entity: "welld_ch",
      company: null,
      projectManager: { id: "user-gone", name: null, deleted: true },
      team: [
        { id: "user-colleague", name: "Name of user-colleague", deleted: false },
        { id: "user-viewer", name: "Name of user-viewer", deleted: false },
      ],
      contracts: [
        {
          id: expect.any(String),
          type: "saas",
          company: { id: "co-zeta", name: "Zeta AG" },
          origin: "manual",
          bexioOrderId: "ORD-7",
          startDate: "2026-03-01",
          endDate: null,
          projectId: project.id,
          dealId: null,
          terms: { sla: null, hourPackage: null },
          version: 1,
        },
      ],
      startDate: "2026-03-01",
      endDate: null,
      version: 1,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it("carries every contract whole (terms, version) with ONE CRM read, however many contracts (no N+1)", async () => {
    const project = await seed({ type: "saas", companyId: null });
    await seedContract(project.id, { type: "saas", companyId: "co-acme", startDate: date("2026-01-01") });
    await seedContract(project.id, { type: "saas", companyId: "co-zeta", startDate: date("2026-02-01") });
    await seedContract(project.id, { type: "saas", companyId: "co-acme", startDate: date("2026-03-01") });
    crm.calls = 0;
    const res = await call("GET", `/projects/${project.id}`, { as: "viewer" });
    expect(res.status).toBe(200);
    expect(crm.calls).toBe(1);
    const contracts = res.json.contracts as { company: { name: string | null }; terms: unknown; version: number }[];
    expect(contracts.map((contract) => contract.company.name)).toEqual(["Acme SA", "Zeta AG", "Acme SA"]);
    for (const contract of contracts) {
      expect(contract.terms).toEqual({ sla: null, hourPackage: null });
      expect(contract.version).toBe(1);
    }
  });

  it.each([
    ["planned", { state: "planned" as const }, null],
    ["active", { state: "active" as const }, null],
    ["closed", { state: "closed" as const }, null],
    ["on_hold, left planned", { state: "on_hold" as const, stateBeforeHold: "planned" as const }, "planned"],
    ["on_hold, left active", { state: "on_hold" as const, stateBeforeHold: "active" as const }, "active"],
  ])("shows `stateBeforeHold` as null unless on hold, else the state it left: %s (AC-1.3)", async (_label, over, expected) => {
    const project = await seed(over);
    const res = await call("GET", `/projects/${project.id}`, { as: "viewer" });
    expect(res.status).toBe(200);
    expect(res.json.stateBeforeHold).toBe(expected);
  });

  it("is 404 for an unknown id, 403 without module access and 401 without a token", async () => {
    expect((await call("GET", "/projects/nope", { as: "viewer" })).status).toBe(404);
    expect((await call("GET", "/projects/nope", { as: "outsider" })).status).toBe(403);
    expect((await call("GET", "/projects/nope", { as: null })).status).toBe(401);
  });

  it("shows a company name of null, not an error, when the CRM cannot answer (AC-1.4 fail soft)", async () => {
    const project = await seed();
    const contract = await seedContract(project.id);
    crm.down = true;
    const res = await call("GET", `/projects/${project.id}`, { as: "viewer" });
    expect(res.status).toBe(200);
    expect(res.json.company).toEqual({ id: "co-acme", name: null });
    expect(res.json.contracts).toEqual([expect.objectContaining({ id: contract.id, company: { id: "co-acme", name: null } })]);
  });

  it("still names a company the CRM has since archived", async () => {
    const project = await seed({ companyId: "co-old" });
    const res = await call("GET", `/projects/${project.id}`, { as: "viewer" });
    expect(res.json.company).toEqual({ id: "co-old", name: "Legacy Ltd" });
  });

  describe("derived dates (AC-1.5)", () => {
    const datesOf = async (contracts: { start: string; end: string | null }[]) => {
      const project = await seed();
      for (const { start, end } of contracts) {
        await seedContract(project.id, { startDate: date(start), endDate: end ? date(end) : null });
      }
      const res = await call("GET", `/projects/${project.id}`, { as: "viewer" });
      return { startDate: res.json.startDate, endDate: res.json.endDate };
    };

    it("are null without a contract", async () => {
      expect(await datesOf([])).toEqual({ startDate: null, endDate: null });
    });

    it("are the earliest start and the latest end of the contracts", async () => {
      expect(
        await datesOf([
          { start: "2026-05-01", end: "2026-12-31" },
          { start: "2026-02-01", end: "2026-09-30" },
          { start: "2026-03-15", end: "2027-03-14" },
        ]),
      ).toEqual({ startDate: "2026-02-01", endDate: "2027-03-14" });
    });

    it("have no end while any contract is open-ended", async () => {
      expect(
        await datesOf([
          { start: "2026-05-01", end: "2026-12-31" },
          { start: "2026-02-01", end: null },
        ]),
      ).toEqual({ startDate: "2026-02-01", endDate: null });
    });

    it("are the one contract's own dates with a single contract", async () => {
      expect(await datesOf([{ start: "2026-02-01", end: "2026-09-30" }])).toEqual({
        startDate: "2026-02-01",
        endDate: "2026-09-30",
      });
    });
  });
});

describe("GET /project-managers", () => {
  it("lists each distinct project manager once, sorted by live name, to a reader who manages nothing (AC-1.4)", async () => {
    await seed({ name: "A", projectManagerId: "user-pm-ch" });
    await seed({ name: "B", projectManagerId: "user-pm-ch" });
    await seed({ name: "C", projectManagerId: "user-colleague" });
    await seed({ name: "D", projectManagerId: "user-accounting", entity: "welld_it" });
    const res = await call("GET", "/project-managers", { as: "viewer" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      items: [
        { id: "user-accounting", name: "Name of user-accounting", deleted: false },
        { id: "user-colleague", name: "Name of user-colleague", deleted: false },
        { id: "user-pm-ch", name: "Name of user-pm-ch", deleted: false },
      ],
    });
  });

  it("is empty with no project", async () => {
    const res = await call("GET", "/project-managers", { as: "viewer" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ items: [] });
  });

  it("names people live, shows a deleted one as deleted, and sorts an unnamed one after the named (ADR-0039)", async () => {
    await seed({ name: "A", projectManagerId: "user-gone" });
    await seed({ name: "B", projectManagerId: "user-colleague" });
    const res = await call("GET", "/project-managers", { as: "viewer" });
    expect(res.json.items).toEqual([
      { id: "user-colleague", name: "Name of user-colleague", deleted: false },
      { id: "user-gone", name: null, deleted: true },
    ]);
  });

  it("fails soft when auth cannot name them: ids with a null name, still 200", async () => {
    await seed({ name: "A", projectManagerId: "user-pm-ch" });
    identities.down = true;
    const res = await call("GET", "/project-managers", { as: "viewer" });
    expect(res.status).toBe(200);
    expect(res.json.items).toEqual([{ id: "user-pm-ch", name: null, deleted: false }]);
  });

  it("is 403 without module access and 401 without a token (AC-4.2)", async () => {
    expect((await call("GET", "/project-managers", { as: "outsider" })).status).toBe(403);
    expect((await call("GET", "/project-managers", { as: null })).status).toBe(401);
  });
});

describe("GET /projects", () => {
  const list = (query = "", as: PersonaName | null = "viewer") => call("GET", `/projects${query}`, { as });
  const names = (res: { json: { items: { name: string }[] } }) => res.json.items.map((item) => item.name);

  it("lists projects as summaries, readable by any access holder (AC-1.4, AC-4.3)", async () => {
    const client = await seed({ name: "Koordy portal" });
    await seedContract(client.id, { companyId: "co-acme" });
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      items: [
        {
          id: client.id,
          name: "Koordy portal",
          type: "t_and_m",
          state: "planned",
          entity: "welld_ch",
          company: { id: "co-acme", name: "Acme SA" },
          clientCount: 1,
          projectManager: { id: "user-pm-ch", name: "Name of user-pm-ch", deleted: false },
        },
      ],
      page: 1,
      pageSize: 25,
      total: 1,
    });
  });

  it("is an empty page, not an error, with no project", async () => {
    expect((await list()).json).toEqual({ items: [], page: 1, pageSize: 25, total: 0 });
  });

  it("is 401 without a token and 403 without module access (AC-4.2)", async () => {
    expect((await list("", null)).status).toBe(401);
    expect((await list("", "outsider")).status).toBe(403);
  });

  it("pages by 25 and sorts by name (AC-1.4)", async () => {
    await db.project.createMany({
      data: Array.from({ length: 27 }, (_, i) => ({
        name: `Project ${String(i).padStart(2, "0")}`,
        type: "internal" as const,
        entity: "welld_ch" as const,
        projectManagerId: "user-pm-ch",
        createdById: "user-pm-ch",
      })),
    });
    const first = await list();
    expect(first.json).toMatchObject({ page: 1, pageSize: 25, total: 27 });
    expect(first.json.items).toHaveLength(25);
    expect(names(first)[0]).toBe("Project 00");
    expect(names(first)[24]).toBe("Project 24");
    const second = await list("?page=2");
    expect(second.json).toMatchObject({ page: 2, pageSize: 25, total: 27 });
    expect(names(second)).toEqual(["Project 25", "Project 26"]);
  });

  it("sorts by name, whatever the order of creation", async () => {
    for (const name of ["Delta", "Alpha", "Charlie", "Bravo"]) await seed({ name, type: "internal", companyId: null });
    expect(names(await list())).toEqual(["Alpha", "Bravo", "Charlie", "Delta"]);
  });

  it("searches the name as a case-insensitive substring (AC-1.4)", async () => {
    for (const name of ["Koordy", "Intranet koordinaten", "Billing"]) await seed({ name, type: "internal", companyId: null });
    expect(names(await list("?q=KOORD"))).toEqual(["Intranet koordinaten", "Koordy"]);
    expect(names(await list("?q=zzz"))).toEqual([]);
  });

  it("filters by type, state and project manager, alone or together (AC-1.4)", async () => {
    await seed({ name: "A", type: "internal", companyId: null, state: "active", projectManagerId: "user-colleague" });
    await seed({ name: "B", type: "internal", companyId: null, state: "planned", projectManagerId: "user-colleague" });
    await seed({ name: "C", type: "saas", companyId: null, state: "active", projectManagerId: "user-pm-ch" });
    await seed({ name: "D", type: "maintenance", state: "closed", projectManagerId: "user-pm-ch" });
    expect(names(await list("?type=internal"))).toEqual(["A", "B"]);
    expect(names(await list("?state=active"))).toEqual(["A", "C"]);
    expect(names(await list("?projectManagerId=user-pm-ch"))).toEqual(["C", "D"]);
    expect(names(await list("?type=internal&state=active&projectManagerId=user-colleague"))).toEqual(["A"]);
    const filtered = await list("?state=active&q=a");
    expect(names(filtered)).toEqual(["A"]);
    expect(filtered.json.total).toBe(1);
  });

  it("is 400 `validation_failed` for an unknown type or state or a page below 1", async () => {
    for (const query of ["?type=retainer", "?state=paused", "?page=0", "?page=abc"]) {
      const res = await list(query);
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({ code: "validation_failed" });
    }
  });

  it("counts a saas project's clients as the distinct companies of its contracts (AC-1.4)", async () => {
    const saas = await seed({ name: "Koordy", type: "saas", companyId: null });
    await seedContract(saas.id, { type: "saas", companyId: "co-acme" });
    await seedContract(saas.id, { type: "saas", companyId: "co-acme", startDate: date("2026-06-01") });
    await seedContract(saas.id, { type: "saas", companyId: "co-zeta" });
    const lonely = await seed({ name: "Tools", type: "internal", companyId: null });
    const res = await list();
    expect(res.json.items).toEqual([
      expect.objectContaining({ id: saas.id, company: null, clientCount: 2 }),
      expect.objectContaining({ id: lonely.id, company: null, clientCount: 0 }),
    ]);
  });

  it("asks the CRM once for the whole page, and degrades company names to null when it is down (AC-1.4)", async () => {
    for (const name of ["A", "B", "C"]) await seed({ name });
    await list();
    expect(crm.calls).toBe(1);
    crm.down = true;
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.json.items.map((item: { company: unknown }) => item.company)).toEqual(
      Array(3).fill({ id: "co-acme", name: null }),
    );
  });

  it("does not call the CRM for a page with no company to name", async () => {
    await seed({ type: "internal", companyId: null });
    await list();
    expect(crm.calls).toBe(0);
  });
});

describe("PATCH /projects/:id", () => {
  const patch = (id: string, body: Record<string, unknown>, options: { as?: PersonaName | null; ifMatch?: number | string } = {}) =>
    call("PATCH", `/projects/${id}`, {
      as: options.as === undefined ? "pmCh" : options.as,
      body,
      ...(options.ifMatch === undefined ? { ifMatch: 1 } : { ifMatch: options.ifMatch }),
    });

  it("renames a project: 200 with the whole Project, version 2 and a fresh ETag (AC-1.1, AC-1.7)", async () => {
    const project = await seed({ name: "Koordy" });
    await seedContract(project.id);
    const res = await patch(project.id, { name: "  Koordy 2  " });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"2"');
    expect(res.json).toMatchObject({
      id: project.id,
      name: "Koordy 2",
      version: 2,
      company: { id: "co-acme", name: "Acme SA" },
      contracts: [expect.objectContaining({ company: { id: "co-acme", name: "Acme SA" } })],
      startDate: "2026-01-01",
    });
    expect(await db.project.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({
      name: "Koordy 2",
      version: 2,
      projectManagerId: "user-pm-ch",
    });
  });

  it("changes the project manager to another project-module user (AC-1.6)", async () => {
    const project = await seed();
    const res = await patch(project.id, { projectManagerId: "user-colleague" });
    expect(res.status).toBe(200);
    expect(res.json.projectManager).toEqual({ id: "user-colleague", name: "Name of user-colleague", deleted: false });
    expect((await db.project.findUniqueOrThrow({ where: { id: project.id } })).projectManagerId).toBe("user-colleague");
  });

  it("refuses a project manager without module access: 422 `not_project_user`, nothing changes (AC-1.6)", async () => {
    const project = await seed();
    const res = await patch(project.id, { name: "Renamed", projectManagerId: "user-employee" });
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ code: "not_project_user", userIds: ["user-employee"] });
    expect(await db.project.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({ name: "Koordy", version: 1 });
  });

  it("is 503 when auth cannot say whether the new project manager has access (AC-1.6)", async () => {
    const project = await seed();
    identities.down = true;
    const res = await patch(project.id, { projectManagerId: "user-colleague" });
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ code: "identity_unavailable" });
    expect((await db.project.findUniqueOrThrow({ where: { id: project.id } })).version).toBe(1);
  });

  it("does not re-check a project manager who is not being changed, so a rename survives their lost access", async () => {
    const project = await seed({ projectManagerId: "user-colleague" });
    appAccess.projects.delete("user-colleague");
    expect((await patch(project.id, { name: "Renamed", projectManagerId: "user-colleague" })).status).toBe(200);
  });

  it("is 428 `precondition_required` without an If-Match (AC-1.7)", async () => {
    const project = await seed();
    const res = await call("PATCH", `/projects/${project.id}`, { as: "pmCh", body: { name: "Renamed" } });
    expect(res.status).toBe(428);
    expect(res.json).toMatchObject({ status: 428, code: "precondition_required" });
    expect((await db.project.findUniqueOrThrow({ where: { id: project.id } })).name).toBe("Koordy");
  });

  it("is 409 `version_conflict` naming the current version when the edit is stale, and the second save is refused (AC-1.7)", async () => {
    const project = await seed();
    expect((await patch(project.id, { name: "First" }, { ifMatch: 1 })).status).toBe(200);
    const stale = await patch(project.id, { name: "Second" }, { ifMatch: 1 });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ status: 409, code: "version_conflict", currentVersion: 2 });
    expect((await db.project.findUniqueOrThrow({ where: { id: project.id } })).name).toBe("First");
    expect((await patch(project.id, { name: "Second" }, { ifMatch: 2 })).status).toBe(200);
  });

  it("lets exactly one of two simultaneous saves of the same version win (AC-1.7)", async () => {
    const project = await seed();
    const results = await Promise.all([patch(project.id, { name: "One" }), patch(project.id, { name: "Two" })]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect((await db.project.findUniqueOrThrow({ where: { id: project.id } })).version).toBe(2);
  });

  it("is 404 for an unknown project", async () => {
    expect((await patch("nope", { name: "Renamed" })).status).toBe(404);
  });

  it("refuses the other entity's project: 403 `out_of_scope`; and a reader: 403 `forbidden` (AC-4.4)", async () => {
    const itProject = await seed({ entity: "welld_it" });
    const outOfScope = await patch(itProject.id, { name: "Renamed" });
    expect(outOfScope.status).toBe(403);
    expect(outOfScope.json).toMatchObject({ code: "out_of_scope" });
    const reader = await patch(itProject.id, { name: "Renamed" }, { as: "viewer" });
    expect(reader.status).toBe(403);
    expect(reader.json).toMatchObject({ code: "forbidden" });
    expect((await patch(itProject.id, { name: "Renamed" }, { as: "salesIt" })).status).toBe(200);
    expect((await patch(itProject.id, { name: "Renamed again" }, { as: "admin", ifMatch: 2 })).status).toBe(200);
  });

  it("is 401 without a token and 403 without module access (AC-4.2)", async () => {
    const project = await seed();
    expect((await patch(project.id, { name: "Renamed" }, { as: null })).status).toBe(401);
    expect((await patch(project.id, { name: "Renamed" }, { as: "outsider" })).status).toBe(403);
  });

  it.each([
    ["nothing to change", {}],
    ["a blank name", { name: "  " }],
    ["a name over 200 characters", { name: "x".repeat(201) }],
    ["a state", { state: "active" }],
    ["a type", { type: "saas" }],
    ["an entity", { entity: "welld_it" }],
    ["a company", { companyId: "co-zeta" }],
  ])("is 400 `validation_failed` for %s (type, entity, company are fixed at creation)", async (_label, body) => {
    const project = await seed();
    const res = await patch(project.id, body);
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: "validation_failed" });
    expect((await db.project.findUniqueOrThrow({ where: { id: project.id } })).version).toBe(1);
  });
});
