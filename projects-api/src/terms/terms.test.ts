/**
 * The terms of a project (specs/021 T8 as renamed by specs/022 T23; AC-1.7, AC-1.8, AC-2.1 – AC-2.10,
 * AC-3.1, AC-5.2 – AC-5.4). Runs the ASSEMBLED app against the `*_test` database; auth and the CRM are
 * the fakes of test-support/world.ts. Projects are seeded straight in the database (the API under test
 * is not its own fixture). The wire shape is specs/021's contract shape, renamed:
 * `{ startDate, endDate?, terms }` in, `{ id, type, startDate, endDate, terms, version }` out.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { call, crm, db, resetWorld, seedDealProject, type PersonaName } from "../test-support/world";
import type { Prisma } from "../lib/generated/prisma/client";

beforeEach(async () => {
  await resetWorld();
  crm.companies = [{ id: "co-acme", name: "Acme SA", entity: "welld_ch", archived: false }];
});

type Type = "t_and_m" | "fixed_price" | "maintenance" | "saas" | "internal";

/** A hand-made project straight in the database: a company for every type but `internal`; no terms yet. */
const seed = (type: Type, over: Partial<Prisma.ProjectUncheckedCreateInput> = {}) =>
  db.project.create({
    data: {
      name: `Project ${type}`,
      type,
      entity: "welld_ch",
      companyId: type === "internal" ? null : "co-acme",
      projectManagerId: "user-pm-ch",
      createdById: "user-pm-ch",
      ...over,
    },
  });

const create = (projectId: string, body: unknown, as: PersonaName | null = "pmCh") =>
  call("POST", `/projects/${projectId}/terms`, { as, body });

const patch = (projectId: string, body: unknown, as: PersonaName | null = "pmCh", ifMatch: number | string = 1) =>
  call("PATCH", `/projects/${projectId}/terms`, { as, body, ifMatch });

const remove = (projectId: string, as: PersonaName | null = "pmCh", ifMatch: number | string = 1) =>
  call("DELETE", `/projects/${projectId}/terms`, { as, ifMatch });

const page = async (projectId: string) => (await call("GET", `/projects/${projectId}`, { as: "viewer" })).json;

const start = { startDate: "2026-12-01" };

/** The terms each type is created with in these tests. */
const TERMS = {
  fixed_price: { deadline: "2027-03-31", estimatedManDays: 40, maxEffortManDays: 55.5 },
  maintenance: { sla: { highDays: 1, normalDays: 3 }, hourPackage: null },
  saas: { sla: null, hourPackage: null },
  t_and_m: { positions: [{ profile: "Senior developer", plannedManDays: 120 }] },
} as const;

const termsCount = () => db.projectTerms.count();

describe("POST /projects/:id/terms — terms per project type (AC-2.1, AC-2.3 – AC-2.8, AC-5.3)", () => {
  it("creates fixed price terms: 201, the project's type, the ETag, the terms nested (AC-2.1, AC-2.3)", async () => {
    const project = await seed("fixed_price");
    const res = await create(project.id, { ...start, terms: TERMS.fixed_price });
    expect(res.status).toBe(201);
    expect(res.headers.get("ETag")).toBe('"1"');
    expect(res.json).toEqual({
      id: expect.any(String),
      type: "fixed_price",
      startDate: "2026-12-01",
      endDate: null,
      terms: { deadline: "2027-03-31", estimatedManDays: 40, maxEffortManDays: 55.5 },
      version: 1,
    });
    expect(await db.projectTerms.findUniqueOrThrow({ where: { id: res.json.id } })).toMatchObject({
      projectId: project.id,
      type: "fixed_price",
    });
  });

  it("creates maintenance terms with an SLA and an hour package, and a yearly package without expiry (AC-2.4 – AC-2.6)", async () => {
    const project = await seed("maintenance");
    const res = await create(project.id, {
      ...start,
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
    const other = await seed("maintenance", { name: "Second" });
    const yearly = await create(other.id, { ...start, terms: { hourPackage: { hours: 120, kind: "yearly", startDate: "2026-12-01" } } });
    expect(yearly.status).toBe(201);
    expect(yearly.json.terms).toEqual({
      sla: null,
      hourPackage: { hours: 120, kind: "yearly", startDate: "2026-12-01", expiryDate: null },
    });
  });

  it("creates T&M terms with their positions, in the order given (AC-2.7)", async () => {
    const project = await seed("t_and_m");
    const res = await create(project.id, {
      ...start,
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

  it("creates SaaS terms, the licence period, with neither SLA nor hours: the dates alone are enough (AC-2.8, AC-5.3)", async () => {
    const project = await seed("saas");
    const res = await create(project.id, { ...start, endDate: "2027-11-30" });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      type: "saas",
      startDate: "2026-12-01",
      endDate: "2027-11-30",
      terms: { sla: null, hourPackage: null },
    });
  });

  it("shows the terms on the project page, with their dates (AC-5.4)", async () => {
    const project = await seed("fixed_price");
    expect((await page(project.id)).terms).toBeNull();
    await create(project.id, { ...start, endDate: "2027-06-30", terms: TERMS.fixed_price });
    const shown = await page(project.id);
    expect(shown).toMatchObject({ startDate: "2026-12-01", endDate: "2027-06-30", purchaseOrder: null });
    expect(shown.terms).toMatchObject({ type: "fixed_price", terms: { deadline: "2027-03-31" } });
  });
});

// ─── Validation ──────────────────────────────────────────────────────────────

/** One request the API must refuse as a 400 `validation_failed` naming `field`, and store nothing. */
interface Bad {
  readonly what: string;
  readonly type: Type;
  readonly body: unknown;
  readonly field: string;
}
const BAD: readonly Bad[] = [
  // fixed_price (AC-2.3)
  { what: "no terms at all", type: "fixed_price", body: { ...start }, field: "terms.deadline" },
  { what: "no deadline", type: "fixed_price", body: { ...start, terms: { maxEffortManDays: 10 } }, field: "terms.deadline" },
  { what: "no max effort", type: "fixed_price", body: { ...start, terms: { deadline: "2027-01-31" } }, field: "terms.maxEffortManDays" },
  { what: "max effort of zero", type: "fixed_price", body: { ...start, terms: { deadline: "2027-01-31", maxEffortManDays: 0 } }, field: "terms.maxEffortManDays" },
  { what: "max effort with two decimals", type: "fixed_price", body: { ...start, terms: { deadline: "2027-01-31", maxEffortManDays: 10.25 } }, field: "terms.maxEffortManDays" },
  { what: "a negative estimate", type: "fixed_price", body: { ...start, terms: { deadline: "2027-01-31", maxEffortManDays: 10, estimatedManDays: -1 } }, field: "terms.estimatedManDays" },
  { what: "a deadline that is not a date", type: "fixed_price", body: { ...start, terms: { deadline: "2027-02-30", maxEffortManDays: 10 } }, field: "terms.deadline" },
  { what: "a price, which no terms carry", type: "fixed_price", body: { ...start, terms: { deadline: "2027-01-31", maxEffortManDays: 10, price: 5000 } }, field: "terms" },
  { what: "terms that are not an object", type: "fixed_price", body: { ...start, terms: "soon" }, field: "terms" },
  // SLA (AC-2.5), on both types that take one
  { what: "an SLA priority above 60", type: "maintenance", body: { ...start, terms: { sla: { highDays: 61, normalDays: 3 } } }, field: "terms.sla.highDays" },
  { what: "a negative SLA priority", type: "saas", body: { ...start, terms: { sla: { highDays: 1, normalDays: -1 } } }, field: "terms.sla.normalDays" },
  { what: "a fractional SLA priority", type: "maintenance", body: { ...start, terms: { sla: { highDays: 1.5, normalDays: 3 } } }, field: "terms.sla.highDays" },
  { what: "an SLA with one priority only", type: "maintenance", body: { ...start, terms: { sla: { highDays: 1 } } }, field: "terms.sla.normalDays" },
  // hour package (AC-2.6)
  { what: "zero hours", type: "maintenance", body: { ...start, terms: { hourPackage: { hours: 0, kind: "yearly", startDate: "2026-12-01" } } }, field: "terms.hourPackage.hours" },
  { what: "fractional hours", type: "maintenance", body: { ...start, terms: { hourPackage: { hours: 7.5, kind: "yearly", startDate: "2026-12-01" } } }, field: "terms.hourPackage.hours" },
  { what: "an unknown package kind", type: "maintenance", body: { ...start, terms: { hourPackage: { hours: 10, kind: "monthly", startDate: "2026-12-01" } } }, field: "terms.hourPackage.kind" },
  { what: "a package without a start date", type: "maintenance", body: { ...start, terms: { hourPackage: { hours: 10, kind: "capacity" } } }, field: "terms.hourPackage.startDate" },
  { what: "an expiry on a yearly package", type: "saas", body: { ...start, terms: { hourPackage: { hours: 10, kind: "yearly", startDate: "2026-12-01", expiryDate: "2027-12-01" } } }, field: "terms.hourPackage.expiryDate" },
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
  { what: "a company of its own", type: "saas", body: { ...start, companyId: "co-acme", terms: TERMS.saas }, field: "" },
  { what: "a Bexio order id (accounting writes it elsewhere)", type: "fixed_price", body: { ...start, bexioOrderId: "AB-1", terms: TERMS.fixed_price }, field: "" },
];

describe("POST /projects/:id/terms — validation (AC-2.3 – AC-2.7, AC-5.3)", () => {
  it.each(BAD)("refuses $what on $type: 400 naming `$field`, nothing stored", async ({ type, body, field }) => {
    const project = await seed(type);
    const res = await create(project.id, body);
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ status: 400, code: "validation_failed" });
    expect(res.json.field).toBe(field);
    expect(await termsCount()).toBe(0);
  });

  it("refuses maintenance terms with neither an SLA nor an hour package: 422 `maintenance_needs_sla_or_hours` (AC-2.4)", async () => {
    const project = await seed("maintenance");
    for (const terms of [undefined, {}, { sla: null, hourPackage: null }]) {
      const res = await create(project.id, { ...start, ...(terms === undefined ? {} : { terms }) });
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ status: 422, code: "maintenance_needs_sla_or_hours", field: "terms" });
    }
    expect(await termsCount()).toBe(0);
  });

  it("accepts the edges: 0-day and 60-day SLA, an estimate of zero, one decimal, a capacity package expiring on its start day", async () => {
    const sla = await create((await seed("maintenance")).id, { ...start, terms: { sla: { highDays: 0, normalDays: 60 } } });
    expect(sla.status).toBe(201);
    expect(sla.json.terms.sla).toEqual({ highDays: 0, normalDays: 60 });
    const sameDay = await create((await seed("maintenance", { name: "B" })).id, {
      ...start,
      terms: { hourPackage: { hours: 1, kind: "capacity", startDate: "2026-12-01", expiryDate: "2026-12-01" } },
    });
    expect(sameDay.status).toBe(201);
    const edge = await create((await seed("fixed_price", { name: "C" })).id, {
      ...start,
      endDate: "2026-12-01",
      terms: { deadline: "2026-12-01", estimatedManDays: 0, maxEffortManDays: 0.1 },
    });
    expect(edge.status).toBe(201);
    expect(edge.json).toMatchObject({ endDate: "2026-12-01", terms: { estimatedManDays: 0, maxEffortManDays: 0.1 } });
  });

  it("is 404 for an unknown project", async () => {
    expect((await create("nope", { ...start, terms: TERMS.fixed_price })).status).toBe(404);
  });
});

// ─── What a project takes ────────────────────────────────────────────────────

describe("POST /projects/:id/terms — which project takes terms (AC-5.2, AC-5.3)", () => {
  it("refuses an internal project: 409 `terms_not_allowed`", async () => {
    const project = await seed("internal");
    const res = await create(project.id, { ...start, terms: {} });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ status: 409, code: "terms_not_allowed" });
    expect(await termsCount()).toBe(0);
  });

  it("refuses a second set: 409 `terms_exist`, on a hand-made project and on one made from a deal", async () => {
    const project = await seed("fixed_price");
    expect((await create(project.id, { ...start, terms: TERMS.fixed_price })).status).toBe(201);
    const second = await create(project.id, { ...start, terms: TERMS.fixed_price });
    expect(second.status).toBe(409);
    expect(second.json).toMatchObject({ code: "terms_exist" });
    const fromDeal = await seedDealProject();
    const third = await create(fromDeal.project.id, { ...start, terms: TERMS.fixed_price });
    expect(third.status).toBe(409);
    expect(third.json).toMatchObject({ code: "terms_exist" });
    expect(await termsCount()).toBe(2);
  });

  it.each(["closed", "cancelled"] as const)("refuses a %s project: 409 `project_not_open`", async (state) => {
    const project = await seed("fixed_price", { state });
    const res = await create(project.id, { ...start, terms: TERMS.fixed_price });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ status: 409, code: "project_not_open", state });
    expect(await termsCount()).toBe(0);
  });

  it.each([{ state: "planned" }, { state: "active" }, { state: "on_hold", stateBeforeHold: "active" }] as const)(
    "takes terms on a $state project",
    async (over) => {
      const project = await seed("fixed_price", over);
      expect((await create(project.id, { ...start, terms: TERMS.fixed_price })).status).toBe(201);
    },
  );

  it("needs no CRM: the terms carry no company", async () => {
    const project = await seed("fixed_price");
    crm.down = true;
    expect((await create(project.id, { ...start, terms: TERMS.fixed_price })).status).toBe(201);
  });

  it("gives terms their project's type, for every type that takes them (D25)", async () => {
    for (const type of ["t_and_m", "fixed_price", "maintenance", "saas"] as const) {
      const project = await seed(type, { name: `P ${type}` });
      const res = await create(project.id, { ...start, terms: TERMS[type] });
      expect(res.status).toBe(201);
      expect(res.json.type).toBe(type);
      expect((await db.projectTerms.findUniqueOrThrow({ where: { id: res.json.id } })).type).toBe(type);
    }
  });
});

describe("POST /projects/:id/terms — who may (AC-4.4)", () => {
  const body = { ...start, terms: TERMS.fixed_price };

  it.each(["viewer", "accounting"] as const)("refuses %s, who manages nothing: 403 `forbidden`, even with a bad body", async (as) => {
    const project = await seed("fixed_price");
    const res = await create(project.id, body, as);
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "forbidden" });
    expect((await create(project.id, { nonsense: true }, as)).status).toBe(403);
    expect(await termsCount()).toBe(0);
  });

  it("refuses the caller with no module access (403) and no token (401) (AC-4.2)", async () => {
    const project = await seed("fixed_price");
    expect((await create(project.id, body, "outsider")).status).toBe(403);
    expect((await create(project.id, body, null)).status).toBe(401);
  });

  it("refuses a manager of the other entity: 403 `out_of_scope`; the entity's own manager and an admin may", async () => {
    const itProject = await seed("fixed_price", { entity: "welld_it" });
    const res = await create(itProject.id, body, "pmCh");
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "out_of_scope" });
    expect(await termsCount()).toBe(0);
    expect((await create(itProject.id, body, "salesIt")).status).toBe(201);
    const other = await seed("fixed_price", { entity: "welld_it", name: "Other" });
    expect((await create(other.id, body, "admin")).status).toBe(201);
  });
});

// ─── Edit ────────────────────────────────────────────────────────────────────

/** A hand-made project with its terms, created through the API. */
async function withTerms(type: Exclude<Type, "internal"> = "fixed_price", over: Partial<Prisma.ProjectUncheckedCreateInput> = {}) {
  const project = await seed(type, over);
  // An admin manages both entities, so the fixture does not depend on who is under test.
  const res = await create(project.id, { ...start, terms: TERMS[type] }, "admin");
  expect(res.status).toBe(201);
  return { project, terms: res.json as { id: string } };
}

describe("PATCH /projects/:id/terms — dates and terms (AC-2.1, AC-2.3 – AC-2.7, AC-1.7, AC-1.8, AC-5.4)", () => {
  it("changes the dates: 200 with the Terms, the new ETag and version, stored; the terms are not part of the edit", async () => {
    const { project, terms } = await withTerms();
    const res = await patch(project.id, { startDate: "2026-12-15", endDate: "2027-06-30" });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"2"');
    expect(res.json).toMatchObject({ id: terms.id, startDate: "2026-12-15", endDate: "2027-06-30", version: 2 });
    expect(res.json.terms).toEqual({ deadline: "2027-03-31", estimatedManDays: 40, maxEffortManDays: 55.5 });
    expect(await db.projectTerms.findUniqueOrThrow({ where: { id: terms.id } })).toMatchObject({ version: 2 });
  });

  it("ends terms by setting their end date, which the project page shows; `null` reopens them (AC-2.10)", async () => {
    const { project } = await withTerms();
    const ended = await patch(project.id, { endDate: "2027-01-31" });
    expect(ended.status).toBe(200);
    expect(ended.json.endDate).toBe("2027-01-31");
    expect(await page(project.id)).toMatchObject({ startDate: "2026-12-01", endDate: "2027-01-31" });
    const reopened = await patch(project.id, { endDate: null }, "pmCh", 2);
    expect(reopened.status).toBe(200);
    expect(reopened.json.endDate).toBeNull();
  });

  it("may edit the terms of a closed project (only NEW terms are refused there)", async () => {
    const { project } = await withTerms();
    await db.project.update({ where: { id: project.id }, data: { state: "closed" } });
    expect((await patch(project.id, { endDate: "2027-01-31" })).status).toBe(200);
  });

  it("replaces fixed price terms whole: an omitted estimate is cleared on a hand-made project", async () => {
    const { project } = await withTerms();
    const res = await patch(project.id, { terms: { deadline: "2027-09-01", maxEffortManDays: 70 } });
    expect(res.status).toBe(200);
    expect(res.json.terms).toEqual({ deadline: "2027-09-01", estimatedManDays: null, maxEffortManDays: 70 });
  });

  it("replaces maintenance terms whole: dropping the SLA clears it, an hour package arrives with its dates (AC-2.4 – AC-2.6)", async () => {
    const { project, terms } = await withTerms("maintenance");
    const res = await patch(project.id, {
      terms: { hourPackage: { hours: 200, kind: "capacity", startDate: "2027-01-01", expiryDate: "2027-12-31" } },
    });
    expect(res.status).toBe(200);
    expect(res.json.terms).toEqual({
      sla: null,
      hourPackage: { hours: 200, kind: "capacity", startDate: "2027-01-01", expiryDate: "2027-12-31" },
    });
    expect(await db.projectTerms.findUniqueOrThrow({ where: { id: terms.id } })).toMatchObject({
      slaHighDays: null,
      slaNormalDays: null,
      hourPackageKind: "capacity",
    });
    // A yearly package replacing a capacity one leaves no stale expiry behind.
    const yearly = await patch(project.id, { terms: { hourPackage: { hours: 50, kind: "yearly", startDate: "2027-01-01" } } }, "pmCh", 2);
    expect(yearly.json.terms.hourPackage).toEqual({ hours: 50, kind: "yearly", startDate: "2027-01-01", expiryDate: null });
  });

  it("refuses to strip maintenance terms of both SLA and hours: 422, unchanged (AC-2.4)", async () => {
    const { project, terms } = await withTerms("maintenance");
    const res = await patch(project.id, { terms: { sla: null, hourPackage: null } });
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ code: "maintenance_needs_sla_or_hours" });
    expect(await db.projectTerms.findUniqueOrThrow({ where: { id: terms.id } })).toMatchObject({ slaHighDays: 1, version: 1 });
  });

  it("lets a SaaS licence drop both SLA and hours: its dates are its terms (AC-2.8)", async () => {
    const { project } = await withTerms("saas");
    const withSla = await patch(project.id, { terms: { sla: { highDays: 2, normalDays: 5 } } });
    expect(withSla.json.terms).toEqual({ sla: { highDays: 2, normalDays: 5 }, hourPackage: null });
    const bare = await patch(project.id, { terms: {} }, "pmCh", 2);
    expect(bare.status).toBe(200);
    expect(bare.json.terms).toEqual({ sla: null, hourPackage: null });
  });

  it("replaces T&M positions, in the order given; never down to none (AC-2.7)", async () => {
    const { project, terms } = await withTerms("t_and_m");
    const res = await patch(project.id, {
      terms: { positions: [{ profile: "Tester", plannedManDays: 10 }, { profile: "PM", plannedManDays: 5.5 }, { profile: "Dev", plannedManDays: 90 }] },
    });
    expect(res.status).toBe(200);
    expect(res.json.terms.positions.map((p: { profile: string }) => p.profile)).toEqual(["Tester", "PM", "Dev"]);
    expect(await db.projectTermsPosition.count({ where: { termsId: terms.id } })).toBe(3);
    const none = await patch(project.id, { terms: { positions: [] } }, "pmCh", 2);
    expect(none.status).toBe(400);
    expect(none.json).toMatchObject({ code: "validation_failed", field: "terms.positions" });
    expect(await db.projectTermsPosition.count({ where: { termsId: terms.id } })).toBe(3);
  });

  it("validates terms against the project's own type: positions on fixed price terms is 400, and nothing changes", async () => {
    const { project, terms } = await withTerms();
    const res = await patch(project.id, { terms: { positions: [{ profile: "Dev", plannedManDays: 1 }] } });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: "validation_failed" });
    expect((await db.projectTerms.findUniqueOrThrow({ where: { id: terms.id } })).version).toBe(1);
  });

  it("refuses dates out of order, against the stored one too: 400", async () => {
    const { project, terms } = await withTerms();
    await patch(project.id, { endDate: "2027-03-01" });
    const early = await patch(project.id, { endDate: "2026-11-30" }, "pmCh", 2);
    expect(early.status).toBe(400);
    expect(early.json).toMatchObject({ code: "validation_failed", field: "endDate" });
    const late = await patch(project.id, { startDate: "2027-03-02" }, "pmCh", 2);
    expect(late.status).toBe(400);
    expect(late.json).toMatchObject({ code: "validation_failed", field: "startDate" });
    const both = await patch(project.id, { startDate: "2027-05-01", endDate: "2027-04-01" }, "pmCh", 2);
    expect(both.status).toBe(400);
    expect((await db.projectTerms.findUniqueOrThrow({ where: { id: terms.id } })).version).toBe(2);
  });

  it.each([
    { what: "an empty body", body: {} },
    { what: "a type", body: { type: "saas" } },
    { what: "a company", body: { companyId: "co-zeta" } },
    { what: "a Bexio order id", body: { bexioOrderId: "AB-1" } },
    { what: "a start date that is not a date", body: { startDate: "nope" } },
    { what: "type-specific members beside the dates (they go in `terms`)", body: { deadline: "2027-09-01" } },
  ])("refuses $what: 400", async ({ body }) => {
    const { project } = await withTerms();
    const res = await patch(project.id, body);
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: "validation_failed" });
  });

  it("is 428 without `If-Match` and 409 `version_conflict` with the current version for a stale one (AC-1.7)", async () => {
    const { project, terms } = await withTerms();
    const none = await call("PATCH", `/projects/${project.id}/terms`, { as: "pmCh", body: { endDate: "2027-01-31" } });
    expect(none.status).toBe(428);
    expect(none.json).toMatchObject({ code: "precondition_required" });
    expect((await patch(project.id, { endDate: "2027-01-31" }, "pmCh", 'W/"1"')).status).toBe(428);
    await patch(project.id, { endDate: "2027-01-31" });
    const stale = await patch(project.id, { endDate: "2027-02-28" });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ status: 409, code: "version_conflict", currentVersion: 2 });
    expect((await db.projectTerms.findUniqueOrThrow({ where: { id: terms.id } })).endDate?.toISOString().slice(0, 10)).toBe("2027-01-31");
  });

  it("lets exactly one of two simultaneous saves of the same version win (AC-1.7)", async () => {
    const { project, terms } = await withTerms();
    const [a, b] = await Promise.all([patch(project.id, { endDate: "2027-01-31" }), patch(project.id, { endDate: "2027-02-28" })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await db.projectTerms.findUniqueOrThrow({ where: { id: terms.id } })).version).toBe(2);
  });

  it("is 404 for an unknown project, and `terms_not_found` for one with no terms (a hand-made project's choice)", async () => {
    expect((await patch("nope", { endDate: "2027-01-31" })).status).toBe(404);
    const bare = await seed("fixed_price");
    const res = await patch(bare.id, { endDate: "2027-01-31" });
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ code: "terms_not_found" });
  });

  it.each(["viewer", "accounting"] as const)("refuses %s: 403 `forbidden`, even with a bad body (AC-4.4)", async (as) => {
    const { project, terms } = await withTerms();
    expect((await patch(project.id, { endDate: "2027-01-31" }, as)).status).toBe(403);
    expect((await patch(project.id, {}, as)).status).toBe(403);
    expect((await db.projectTerms.findUniqueOrThrow({ where: { id: terms.id } })).version).toBe(1);
  });

  it("refuses no module access (403), no token (401), and a manager of the other entity (403 `out_of_scope`)", async () => {
    const { project } = await withTerms("fixed_price", { entity: "welld_it" });
    expect((await patch(project.id, { endDate: "2027-01-31" }, "outsider")).status).toBe(403);
    expect((await patch(project.id, { endDate: "2027-01-31" }, null)).status).toBe(401);
    const res = await patch(project.id, { endDate: "2027-01-31" }, "pmCh");
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "out_of_scope" });
    expect((await patch(project.id, { endDate: "2027-01-31" }, "salesIt")).status).toBe(200);
  });
});

// ─── Estimate-backed man-days stay server-owned (AC-3.1) ─────────────────────

describe("PATCH /projects/:id/terms on a project made from a deal with an estimate (AC-3.1, AC-3.5)", () => {
  const seedEstimated = (estimateId: string | null = "est-1") =>
    seedDealProject({ order: { estimateId }, terms: { estimatedManDays: estimateId ? 40 : null, maxEffortManDays: 55.5 } });

  it.each([
    { what: "a number", value: 12 },
    { what: "null", value: null },
  ])("refuses `terms.estimatedManDays` as $what: 422 `estimated_man_days_from_estimate`, nothing changes", async ({ value }) => {
    const { project, terms } = await seedEstimated();
    const res = await patch(project.id, { terms: { deadline: "2027-04-30", maxEffortManDays: 60, estimatedManDays: value } });
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ code: "estimated_man_days_from_estimate", field: "terms.estimatedManDays" });
    const stored = await db.projectTerms.findUniqueOrThrow({ where: { id: terms.id } });
    expect(stored.version).toBe(1);
    expect(stored.estimatedManDays?.toNumber()).toBe(40);
  });

  it("keeps the stored man-days when `terms` omits the member: the other terms change, the figure does not", async () => {
    const { project, terms } = await seedEstimated();
    const res = await patch(project.id, { terms: { deadline: "2027-04-30", maxEffortManDays: 60 } });
    expect(res.status).toBe(200);
    expect(res.json.terms).toEqual({ deadline: "2027-04-30", estimatedManDays: 40, maxEffortManDays: 60 });
    expect((await db.projectTerms.findUniqueOrThrow({ where: { id: terms.id } })).estimatedManDays?.toNumber()).toBe(40);
  });

  it("keeps the man-days across a dates-only edit", async () => {
    const { project } = await seedEstimated();
    const res = await patch(project.id, { endDate: "2027-06-30" });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ endDate: "2027-06-30", terms: { estimatedManDays: 40 } });
  });

  it("still lets the man-days be edited when the deal had no estimate, as on a hand-made project (AC-3.5)", async () => {
    const { project } = await seedEstimated(null);
    const res = await patch(project.id, { terms: { deadline: "2027-03-31", maxEffortManDays: 55.5, estimatedManDays: 30 } });
    expect(res.status).toBe(200);
    expect(res.json.terms).toMatchObject({ estimatedManDays: 30 });
  });

  it("answers the estimate link and the deal on the project page, not on the terms", async () => {
    const { project } = await seedEstimated();
    const shown = await page(project.id);
    expect(shown.purchaseOrder.estimate).toEqual({ id: "est-1" });
    expect(Object.keys(shown.terms)).not.toContain("estimate");
  });
});

// ─── Remove ──────────────────────────────────────────────────────────────────

describe("DELETE /projects/:id/terms — hand-made projects only (AC-5.4, S5)", () => {
  it("removes the terms of a hand-made project: 204, the row and its positions are gone, the project stays", async () => {
    const { project, terms } = await withTerms("t_and_m");
    const res = await remove(project.id);
    expect(res.status).toBe(204);
    expect(await db.projectTerms.count({ where: { id: terms.id } })).toBe(0);
    expect(await db.projectTermsPosition.count()).toBe(0);
    expect(await page(project.id)).toMatchObject({ terms: null, startDate: null, endDate: null });
  });

  it("lets the terms be added again afterwards", async () => {
    const { project } = await withTerms();
    await remove(project.id);
    expect((await create(project.id, { ...start, terms: TERMS.fixed_price })).status).toBe(201);
  });

  it("refuses a project made from a deal: 409 `terms_required`, the terms stay", async () => {
    const { project, terms } = await seedDealProject();
    const res = await remove(project.id, "admin");
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ status: 409, code: "terms_required" });
    expect(await db.projectTerms.count({ where: { id: terms.id } })).toBe(1);
  });

  it("is 404 for an unknown project, and `terms_not_found` for one with no terms", async () => {
    expect((await remove("nope")).status).toBe(404);
    const bare = await seed("fixed_price");
    const res = await remove(bare.id);
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ code: "terms_not_found" });
  });

  it("takes the version through `If-Match` like every write: 428 without, 409 `version_conflict` for a stale one, the terms stay", async () => {
    const { project, terms } = await withTerms();
    const none = await call("DELETE", `/projects/${project.id}/terms`, { as: "pmCh" });
    expect(none.status).toBe(428);
    expect(none.json).toMatchObject({ code: "precondition_required" });
    const stale = await remove(project.id, "pmCh", 7);
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: "version_conflict", currentVersion: 1 });
    expect(await db.projectTerms.count({ where: { id: terms.id } })).toBe(1);
    expect((await remove(project.id, "pmCh", 1)).status).toBe(204);
  });

  it("does not remove terms someone edited since: a removal of the version it loaded is 409, the edit stays", async () => {
    const { project, terms } = await withTerms();
    expect((await patch(project.id, { endDate: "2027-01-31" })).status).toBe(200);
    const res = await remove(project.id, "pmCh", 1);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: "version_conflict", currentVersion: 2 });
    expect((await db.projectTerms.findUniqueOrThrow({ where: { id: terms.id } })).endDate?.toISOString().slice(0, 10)).toBe("2027-01-31");
  });

  it.each(["viewer", "accounting"] as const)("refuses %s: 403 `forbidden`; no token 401; no access 403; the other entity 403 `out_of_scope`", async (as) => {
    const { project, terms } = await withTerms("fixed_price", { entity: "welld_it" });
    expect((await remove(project.id, as)).status).toBe(403);
    expect((await remove(project.id, null)).status).toBe(401);
    expect((await remove(project.id, "outsider")).status).toBe(403);
    const other = await remove(project.id, "pmCh");
    expect(other.status).toBe(403);
    expect(other.json).toMatchObject({ code: "out_of_scope" });
    expect(await db.projectTerms.count({ where: { id: terms.id } })).toBe(1);
  });

  it("cannot be bypassed by deleting the project: the database restricts it", async () => {
    const { project } = await withTerms();
    await expect((async () => db.project.delete({ where: { id: project.id } }))()).rejects.toThrow();
    expect(await termsCount()).toBe(1);
  });
});

// ─── A project made by hand through POST /projects (specs/022 T28) ───────────

describe("the terms of a project made through POST /projects can be added, edited and removed later (AC-5.2, AC-5.4, S5, A38)", () => {
  /** The project as the API makes it: the creation route is the fixture here, not the database. */
  const make = async (type: Type, terms?: unknown) => {
    const res = await call("POST", "/projects", {
      as: "pmCh",
      body: { name: `By hand ${type}`, type, entity: "welld_ch", ...(type === "internal" ? {} : { companyId: "co-acme" }), ...(terms ? { terms } : {}) },
    });
    expect(res.status).toBe(201);
    return res.json as { id: string; terms: { id: string; version: number } | null };
  };

  it("adds terms to a project created without any, edits them, removes them, and adds them again", async () => {
    const project = await make("fixed_price");
    expect(project.terms).toBeNull();

    const added = await create(project.id, { ...start, terms: TERMS.fixed_price });
    expect(added.status).toBe(201);
    expect(await page(project.id)).toMatchObject({ terms: { type: "fixed_price", terms: TERMS.fixed_price }, startDate: "2026-12-01" });

    const edited = await patch(project.id, { endDate: "2027-04-30", terms: { ...TERMS.fixed_price, maxEffortManDays: 60 } }, "pmCh", added.json.version);
    expect(edited.status).toBe(200);
    expect(edited.json).toMatchObject({ endDate: "2027-04-30", terms: { maxEffortManDays: 60 }, version: 2 });

    const removed = await remove(project.id, "pmCh", edited.json.version);
    expect(removed.status).toBe(204);
    expect(await page(project.id)).toMatchObject({ terms: null, startDate: null, endDate: null });
    expect(await termsCount()).toBe(0);

    expect((await create(project.id, { ...start, terms: TERMS.fixed_price })).status).toBe(201);
    expect(await db.purchaseOrder.count()).toBe(0);
  });

  it("edits and removes the terms it was created with, as a whole: they are optional as a whole (S5)", async () => {
    const project = await make("t_and_m", { ...start, terms: TERMS.t_and_m });
    expect(project.terms).toMatchObject({ version: 1 });

    const edited = await patch(project.id, { terms: { positions: [{ profile: "Tester", plannedManDays: 12 }] } });
    expect(edited.status).toBe(200);
    expect(edited.json.terms).toEqual({ positions: [{ profile: "Tester", plannedManDays: 12 }] });

    // What remains must still meet the type's rules (A38): T&M never down to no position, and a refusal changes nothing.
    const stripped = await patch(project.id, { terms: { positions: [] } }, "pmCh", edited.json.version);
    expect(stripped.status).toBe(400);
    expect((await page(project.id)).terms.terms).toEqual({ positions: [{ profile: "Tester", plannedManDays: 12 }] });

    expect((await remove(project.id, "pmCh", edited.json.version)).status).toBe(204);
    expect(await db.projectTermsPosition.count()).toBe(0);
    expect(await db.project.count()).toBe(1);
  });

  it("refuses to add terms to a project made as internal (it never took any), however it was created", async () => {
    const project = await make("internal");
    const res = await create(project.id, start);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: "terms_not_allowed" });
    expect(await termsCount()).toBe(0);
  });

  it("refuses a second set on a project created with terms: 409 `terms_exist`", async () => {
    const project = await make("saas", start);
    const res = await create(project.id, start);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: "terms_exist" });
    expect(await termsCount()).toBe(1);
  });
});

// ─── Retired routes ──────────────────────────────────────────────────────────

describe("the contract routes of specs/021 are gone (specs/022 D38)", () => {
  it.each([
    ["POST", "/projects/p1/contracts"],
    ["GET", "/projects/p1/contracts/c1"],
    ["PATCH", "/projects/p1/contracts/c1"],
    ["DELETE", "/projects/p1/contracts/c1"],
    ["PUT", "/projects/p1/contracts/c1/bexio-order"],
  ])("%s %s answers 404, for an admin, and writes nothing", async (method, path) => {
    const res = await call(method, path, { as: "admin", body: method === "GET" || method === "DELETE" ? undefined : {}, ifMatch: 1 });
    expect(res.status).toBe(404);
    expect(await termsCount()).toBe(0);
    expect(await db.purchaseOrder.count()).toBe(0);
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

  it("carries no money member in the terms of any type, nor on the project page that shows them", async () => {
    for (const type of ["fixed_price", "maintenance", "t_and_m", "saas"] as const) {
      const { project, terms } = await withTerms(type, { name: `P ${type}` });
      const shown = await page(project.id);
      for (const keys of [keysOf(shown.terms), keysOf(shown)]) {
        expect(keys.filter((key) => MONEY.test(key))).toEqual([]);
      }
      // The check is not vacuous: it sees the keys that ARE there.
      expect(keysOf(shown.terms)).toContain("startDate");
      expect(shown.terms.id).toBe(terms.id);
    }
  });
});
