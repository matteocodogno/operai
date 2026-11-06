/**
 * The rules the schema itself enforces (specs/021 T4, re-shaped by specs/022 T23): Prisma cannot
 * express CHECKs, so the migrations add them by hand, and these tests prove at the DATABASE (after
 * both migrations) that each one refuses what the model forbids. Each refusal is asserted by its constraint's NAME, so a
 * row refused for some other reason (a missing column, a bad enum) cannot pass for it; each
 * rule also has its accepted neighbour, so the refusal is the rule and not the fixture.
 *
 * Runs against the `*_test` database (src/test-support/env.ts, the `bun test` preload).
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { db } from "./lib/db";
import type { Prisma } from "./lib/generated/prisma/client";

type ProjectType = "t_and_m" | "fixed_price" | "maintenance" | "saas" | "internal";

beforeEach(async () => {
  await db.projectTermsPosition.deleteMany();
  await db.projectTerms.deleteMany();
  await db.purchaseOrder.deleteMany();
  await db.projectMember.deleteMany();
  await db.project.deleteMany();
});

/** Every type but `internal` has a company (`saas` is a client type, specs/022 D40). */
const CLIENT_TYPES: ProjectType[] = ["t_and_m", "fixed_price", "maintenance", "saas"];
const date = (iso: string) => new Date(`${iso}T00:00:00Z`);

const projectData = (over: Partial<Prisma.ProjectUncheckedCreateInput> = {}): Prisma.ProjectUncheckedCreateInput => ({
  name: "Koordy",
  type: "t_and_m",
  entity: "welld_ch",
  companyId: "company-1",
  projectManagerId: "user-1",
  createdById: "user-1",
  ...over,
});

const makeProject = (over: Partial<Prisma.ProjectUncheckedCreateInput> = {}) =>
  db.project.create({ data: projectData(over) });

/** Terms of `type` on a fresh project of that type, with `over` applied last. */
async function makeTerms(type: ProjectType, over: Partial<Prisma.ProjectTermsUncheckedCreateInput> = {}) {
  const project = await makeProject({
    type,
    companyId: CLIENT_TYPES.includes(type) ? "company-1" : null,
  });
  return db.projectTerms.create({ data: { projectId: project.id, type, startDate: date("2026-01-01"), ...over } });
}

/** A purchase order on `projectId` (a fresh project when none is given), `over` applied last. */
async function makePurchaseOrder(over: Partial<Prisma.PurchaseOrderUncheckedCreateInput> = {}) {
  const projectId = over.projectId ?? (await makeProject()).id;
  return db.purchaseOrder.create({
    data: { dealId: `deal-${Math.random()}`, opsManagerId: "user-ops", createdById: "user-1", ...over, projectId },
  });
}

/** The error a refused write carries: Prisma wraps the driver's, so match on the text. */
const refusal = (constraint: string) => expect.objectContaining({ message: expect.stringContaining(constraint) });
/** A Prisma query is a lazy thenable, not a Promise: run it inside an async function so `rejects` can see it. */
const refused = (write: PromiseLike<unknown>) =>
  expect(
    (async () => {
      await write;
    })(),
  ).rejects;
const refusedBy = (constraint: string, write: PromiseLike<unknown>) => refused(write).toEqual(refusal(constraint));
/** A unique index: Prisma reports it as P2002 on the field, not by the index's name. */
const refusedDuplicate = (field: string, write: PromiseLike<unknown>) =>
  refused(write).toEqual(expect.objectContaining({ code: "P2002", message: expect.stringContaining(`\`"${field}"\``) }));

describe("project", () => {
  it("requires a company for every type but internal, `saas` included (AC-1.1, specs/022 D40, AC-5.1)", async () => {
    for (const type of CLIENT_TYPES) {
      await refusedBy("project_company_matches_type", makeProject({ type, companyId: null }));
    }
    for (const type of CLIENT_TYPES) {
      expect((await makeProject({ type, companyId: "company-1" })).companyId).toBe("company-1");
    }
  });

  it("allows no company on internal only (AC-1.1)", async () => {
    await refusedBy("project_company_matches_type", makeProject({ type: "internal", companyId: "company-1" }));
    expect((await makeProject({ type: "internal", companyId: null })).companyId).toBeNull();
  });

  it("may have no project manager (a project made from a deal awaits the ops-manager's pick, D42)", async () => {
    expect((await makeProject({ projectManagerId: null })).projectManagerId).toBeNull();
  });

  it("keeps stateBeforeHold iff the project is on hold, and only from planned or active (AC-1.3)", async () => {
    await refusedBy("project_state_before_hold_iff_on_hold", makeProject({ state: "on_hold", stateBeforeHold: null }));
    await refusedBy("project_state_before_hold_iff_on_hold", makeProject({ state: "active", stateBeforeHold: "active" }));
    await refusedBy("project_state_before_hold_from_open_state", makeProject({ state: "on_hold", stateBeforeHold: "closed" }));
    const held = await makeProject({ state: "on_hold", stateBeforeHold: "active" });
    expect(held.stateBeforeHold).toBe("active");
    expect((await makeProject({ state: "planned" })).stateBeforeHold).toBeNull();
  });

  it("starts planned at version 1 and refuses a blank name", async () => {
    const project = await makeProject();
    expect(project).toMatchObject({ state: "planned", version: 1 });
    await refusedBy("project_name_not_blank", makeProject({ name: "   " }));
  });

  it("cannot be deleted while it has terms or a purchase order (never deleted, D34)", async () => {
    const terms = await makeTerms("t_and_m");
    await refused(db.project.delete({ where: { id: terms.projectId } })).toBeDefined();
    const order = await makePurchaseOrder();
    await refused(db.project.delete({ where: { id: order.projectId } })).toBeDefined();
  });
});

describe("terms of a project (specs/022 data model)", () => {
  it("are at most one row per project", async () => {
    const first = await makeTerms("t_and_m");
    await refusedDuplicate("projectId",db.projectTerms.create({ data: { projectId: first.projectId, type: "t_and_m", startDate: date("2026-02-01") } }));
    expect(await db.projectTerms.count()).toBe(1);
  });

  it("are refused on an internal project: the type of terms is never internal", async () => {
    const project = await makeProject({ type: "internal", companyId: null });
    await refusedBy("terms_not_internal", db.projectTerms.create({ data: { projectId: project.id, type: "internal", startDate: date("2026-01-01") } }));
    expect(await db.projectTerms.count()).toBe(0);
    // The neighbour: the same terms on a client project.
    await makeTerms("saas");
  });

  it("never end before they start (specs/021 AC-2.1)", async () => {
    await refusedBy("terms_dates_ordered", makeTerms("saas", { startDate: date("2026-02-01"), endDate: date("2026-01-31") }));
    await makeTerms("saas", { startDate: date("2026-02-01"), endDate: date("2026-02-01") });
    const open = await makeTerms("saas");
    expect(open.endDate).toBeNull();
  });

  it("let saas terms have neither an SLA nor an hour package (specs/021 AC-2.8, A15)", async () => {
    const terms = await makeTerms("saas");
    expect(terms).toMatchObject({ slaHighDays: null, hourPackageHours: null, version: 1 });
  });
});

describe("fixed price terms (specs/021 AC-2.3)", () => {
  const terms = { deadline: date("2026-06-30"), maxEffortManDays: "40.5" };

  it("are refused without a max effort, or with a max effort of zero", async () => {
    await refusedBy("terms_fixed_price_terms", makeTerms("fixed_price", { deadline: date("2026-06-30") }));
    await refusedBy("terms_fixed_price_terms", makeTerms("fixed_price", { ...terms, maxEffortManDays: "0" }));
  });

  it("are refused without a deadline", async () => {
    await refusedBy("terms_fixed_price_terms", makeTerms("fixed_price", { maxEffortManDays: "40.5" }));
  });

  it("are accepted with deadline and max effort, estimated man-days optional", async () => {
    const without = await makeTerms("fixed_price", terms);
    expect(without.estimatedManDays).toBeNull();
    const withEstimate = await makeTerms("fixed_price", { ...terms, estimatedManDays: "35" });
    expect(withEstimate.estimatedManDays?.toString()).toBe("35");
  });

  it("refuse negative estimated man-days", async () => {
    await refusedBy("terms_estimated_man_days_non_negative", makeTerms("fixed_price", { ...terms, estimatedManDays: "-1" }));
  });
});

describe("maintenance terms (specs/021 AC-2.4, AC-2.5, AC-2.6)", () => {
  const sla = { slaHighDays: 1, slaNormalDays: 3 };
  const hours = { hourPackageHours: 80, hourPackageKind: "capacity" as const, hourPackageStart: date("2026-01-01") };

  it("are refused with neither an SLA nor an hour package", async () => {
    await refusedBy("terms_maintenance_needs_sla_or_hours", makeTerms("maintenance"));
  });

  it("are accepted with an SLA, with an hour package, or with both", async () => {
    await makeTerms("maintenance", sla);
    await makeTerms("maintenance", hours);
    const both = await makeTerms("maintenance", { ...sla, ...hours });
    expect(both).toMatchObject({ slaHighDays: 1, slaNormalDays: 3, hourPackageHours: 80 });
  });

  it("refuse an SLA with only one priority", async () => {
    await refusedBy("terms_sla_pair", makeTerms("maintenance", { slaHighDays: 1 }));
    await refusedBy("terms_sla_pair", makeTerms("maintenance", { slaNormalDays: 3, ...hours }));
  });

  it("keep each SLA time within 0-60 working days", async () => {
    await refusedBy("terms_sla_range", makeTerms("maintenance", { slaHighDays: 61, slaNormalDays: 3 }));
    await refusedBy("terms_sla_range", makeTerms("maintenance", { slaHighDays: 1, slaNormalDays: -1 }));
    const edge = await makeTerms("maintenance", { slaHighDays: 0, slaNormalDays: 60 });
    expect(edge).toMatchObject({ slaHighDays: 0, slaNormalDays: 60 });
  });

  it("take an hour package as a group: hours, kind and start together", async () => {
    await refusedBy("terms_hour_package_group", makeTerms("maintenance", { ...sla, hourPackageHours: 80 }));
    await refusedBy("terms_hour_package_group", makeTerms("maintenance", { ...sla, hourPackageKind: "yearly" }));
    await refusedBy("terms_hour_package_group", makeTerms("maintenance", { ...sla, hourPackageStart: date("2026-01-01") }));
  });

  it("need more than zero hours", async () => {
    await refusedBy("terms_hour_package_hours_positive", makeTerms("maintenance", { ...hours, hourPackageHours: 0 }));
  });

  it("give an expiry to a capacity package only", async () => {
    const expiry = { hourPackageExpiry: date("2026-12-31") };
    await refusedBy("terms_hour_package_expiry_capacity_only", makeTerms("maintenance", { ...hours, hourPackageKind: "yearly", ...expiry }));
    const capacity = await makeTerms("maintenance", { ...hours, ...expiry });
    expect(capacity.hourPackageExpiry?.toISOString().slice(0, 10)).toBe("2026-12-31");
    const yearly = await makeTerms("maintenance", { ...hours, hourPackageKind: "yearly" });
    expect(yearly.hourPackageExpiry).toBeNull();
    // An expiry with no package at all is the NULL case a careless CHECK would let through.
    await refusedBy("terms_hour_package_expiry_capacity_only", makeTerms("maintenance", { ...sla, ...expiry }));
  });
});

describe("terms position (specs/021 AC-2.7)", () => {
  it("needs planned man-days above zero and a profile name", async () => {
    const terms = await makeTerms("t_and_m");
    const position = (over: Partial<Prisma.ProjectTermsPositionUncheckedCreateInput>) =>
      db.projectTermsPosition.create({
        data: { termsId: terms.id, profile: "Senior developer", plannedManDays: "12.5", position: 0, ...over },
      });
    await refusedBy("terms_position_man_days_positive", position({ plannedManDays: "0" }));
    await refusedBy("terms_position_profile_not_blank", position({ profile: " " }));
    expect((await position({})).plannedManDays.toString()).toBe("12.5");
  });

  it("goes with its terms", async () => {
    const terms = await makeTerms("t_and_m");
    await db.projectTermsPosition.create({ data: { termsId: terms.id, profile: "QA", plannedManDays: "3", position: 0 } });
    await db.projectTerms.delete({ where: { id: terms.id } });
    expect(await db.projectTermsPosition.count()).toBe(0);
  });
});

describe("purchase order (specs/022 data model, AC-1.6)", () => {
  it("is at most one per project", async () => {
    const first = await makePurchaseOrder();
    await refusedDuplicate("projectId",makePurchaseOrder({ projectId: first.projectId }));
    expect(await db.purchaseOrder.count()).toBe(1);
  });

  it("comes from at most one purchase order per won deal (AC-1.6, the database half)", async () => {
    await makePurchaseOrder({ dealId: "deal-1" });
    await refusedDuplicate("dealId",makePurchaseOrder({ dealId: "deal-1" }));
    await makePurchaseOrder({ dealId: "deal-2" });
  });

  it("is refused without a deal or without an ops-manager", async () => {
    const project = await makeProject();
    const raw = { projectId: project.id, createdById: "user-1" };
    // Prisma refuses a missing required field before the database does; the raw insert reaches it.
    await refusedBy(
      'null value in column "dealId"',
      db.$executeRaw`INSERT INTO purchase_order (id, "projectId", "opsManagerId", "createdById", "updatedAt") VALUES ('po-x', ${raw.projectId}, 'user-ops', ${raw.createdById}, now())`,
    );
    await refusedBy(
      'null value in column "opsManagerId"',
      db.$executeRaw`INSERT INTO purchase_order (id, "projectId", "dealId", "createdById", "updatedAt") VALUES ('po-y', ${raw.projectId}, 'deal-9', ${raw.createdById}, now())`,
    );
    expect(await db.purchaseOrder.count()).toBe(0);
  });

  it("carries the estimate, the Bexio order id and the referent as optional members, and starts at version 1", async () => {
    expect(await makePurchaseOrder()).toMatchObject({ estimateId: null, bexioOrderId: null, referentContactId: null, version: 1 });
    expect(await makePurchaseOrder({ estimateId: "est-1", bexioOrderId: "SO-1", referentContactId: "contact-1" })).toMatchObject({
      estimateId: "est-1",
      bexioOrderId: "SO-1",
      referentContactId: "contact-1",
    });
  });
});

describe("ids", () => {
  it("are text everywhere, never uuid (CRM and auth ids are cuids)", async () => {
    const columns = await db.$queryRaw<{ table_name: string; column_name: string; data_type: string }[]>`
      SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name <> '_prisma_migrations'
        AND column_name IN ('id', 'projectId', 'companyId', 'projectManagerId', 'createdById', 'userId', 'termsId', 'dealId', 'opsManagerId', 'referentContactId')`;
    expect(columns.length).toBeGreaterThan(10);
    for (const column of columns) {
      expect(`${column.table_name}.${column.column_name}: ${column.data_type}`).toBe(`${column.table_name}.${column.column_name}: text`);
    }
    const project = await makeProject();
    expect(project.id).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});
