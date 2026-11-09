/**
 * The rules the schema itself enforces (specs/024 T4): Prisma cannot express CHECKs, so the
 * initial migration adds them by hand, and these tests prove at the DATABASE that each one
 * refuses what the model forbids. Each refusal is asserted by its constraint's NAME, so a
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
  await db.contractPosition.deleteMany();
  await db.contract.deleteMany();
  await db.projectMember.deleteMany();
  await db.project.deleteMany();
});

const CLIENT_TYPES: ProjectType[] = ["t_and_m", "fixed_price", "maintenance"];
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

/** A contract of `type` on a fresh project of that type, with `over` applied last. */
async function makeContract(type: ProjectType, over: Partial<Prisma.ContractUncheckedCreateInput> = {}) {
  const project = await makeProject({
    type,
    companyId: CLIENT_TYPES.includes(type) ? "company-1" : null,
  });
  return db.contract.create({
    data: { projectId: project.id, type, companyId: "company-1", startDate: date("2026-01-01"), ...over },
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

describe("project", () => {
  it("requires a company for a client type (AC-1.1)", async () => {
    for (const type of CLIENT_TYPES) {
      await refusedBy("project_company_iff_client_type", makeProject({ type, companyId: null }));
    }
    for (const type of CLIENT_TYPES) {
      expect((await makeProject({ type, companyId: "company-1" })).companyId).toBe("company-1");
    }
  });

  it("allows no company on saas and internal (AC-1.1)", async () => {
    for (const type of ["saas", "internal"] as const) {
      await refusedBy("project_company_iff_client_type", makeProject({ type, companyId: "company-1" }));
      expect((await makeProject({ type, companyId: null })).companyId).toBeNull();
    }
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

  it("cannot be deleted while it has a contract (AC-2.10: contracts are never deleted)", async () => {
    const contract = await makeContract("t_and_m");
    await refused(db.project.delete({ where: { id: contract.projectId } })).toBeDefined();
  });
});

describe("fixed price contract (AC-2.3)", () => {
  const terms = { deadline: date("2026-06-30"), maxEffortManDays: "40.5" };

  it("is refused without a max effort, or with a max effort of zero", async () => {
    await refusedBy("contract_fixed_price_terms", makeContract("fixed_price", { deadline: date("2026-06-30") }));
    await refusedBy("contract_fixed_price_terms", makeContract("fixed_price", { ...terms, maxEffortManDays: "0" }));
  });

  it("is refused without a deadline", async () => {
    await refusedBy("contract_fixed_price_terms", makeContract("fixed_price", { maxEffortManDays: "40.5" }));
  });

  it("is accepted with deadline and max effort, estimated man-days optional", async () => {
    const without = await makeContract("fixed_price", terms);
    expect(without.estimatedManDays).toBeNull();
    const withEstimate = await makeContract("fixed_price", { ...terms, estimatedManDays: "35" });
    expect(withEstimate.estimatedManDays?.toString()).toBe("35");
  });

  it("refuses negative estimated man-days", async () => {
    await refusedBy("contract_estimated_man_days_non_negative", makeContract("fixed_price", { ...terms, estimatedManDays: "-1" }));
  });
});

describe("maintenance contract (AC-2.4, AC-2.5, AC-2.6)", () => {
  const sla = { slaHighDays: 1, slaNormalDays: 3 };
  const hours = { hourPackageHours: 80, hourPackageKind: "capacity" as const, hourPackageStart: date("2026-01-01") };

  it("is refused with neither an SLA nor an hour package", async () => {
    await refusedBy("contract_maintenance_needs_sla_or_hours", makeContract("maintenance"));
  });

  it("is accepted with an SLA, with an hour package, or with both", async () => {
    await makeContract("maintenance", sla);
    await makeContract("maintenance", hours);
    const both = await makeContract("maintenance", { ...sla, ...hours });
    expect(both).toMatchObject({ slaHighDays: 1, slaNormalDays: 3, hourPackageHours: 80 });
  });

  it("refuses an SLA with only one priority", async () => {
    await refusedBy("contract_sla_pair", makeContract("maintenance", { slaHighDays: 1 }));
    await refusedBy("contract_sla_pair", makeContract("maintenance", { slaNormalDays: 3, ...hours }));
  });

  it("keeps each SLA time within 0-60 working days", async () => {
    await refusedBy("contract_sla_range", makeContract("maintenance", { slaHighDays: 61, slaNormalDays: 3 }));
    await refusedBy("contract_sla_range", makeContract("maintenance", { slaHighDays: 1, slaNormalDays: -1 }));
    const edge = await makeContract("maintenance", { slaHighDays: 0, slaNormalDays: 60 });
    expect(edge).toMatchObject({ slaHighDays: 0, slaNormalDays: 60 });
  });

  it("takes an hour package as a group: hours, kind and start together", async () => {
    await refusedBy("contract_hour_package_group", makeContract("maintenance", { ...sla, hourPackageHours: 80 }));
    await refusedBy("contract_hour_package_group", makeContract("maintenance", { ...sla, hourPackageKind: "yearly" }));
    await refusedBy("contract_hour_package_group", makeContract("maintenance", { ...sla, hourPackageStart: date("2026-01-01") }));
  });

  it("needs more than zero hours", async () => {
    await refusedBy("contract_hour_package_hours_positive", makeContract("maintenance", { ...hours, hourPackageHours: 0 }));
  });

  it("gives an expiry to a capacity package only", async () => {
    const expiry = { hourPackageExpiry: date("2026-12-31") };
    await refusedBy("contract_hour_package_expiry_capacity_only", makeContract("maintenance", { ...hours, hourPackageKind: "yearly", ...expiry }));
    const capacity = await makeContract("maintenance", { ...hours, ...expiry });
    expect(capacity.hourPackageExpiry?.toISOString().slice(0, 10)).toBe("2026-12-31");
    const yearly = await makeContract("maintenance", { ...hours, hourPackageKind: "yearly" });
    expect(yearly.hourPackageExpiry).toBeNull();
    // An expiry with no package at all is the NULL case a careless CHECK would let through.
    await refusedBy("contract_hour_package_expiry_capacity_only", makeContract("maintenance", { ...sla, ...expiry }));
  });
});

describe("any contract", () => {
  it("never ends before it starts (AC-2.1)", async () => {
    await refusedBy("contract_dates_ordered", makeContract("saas", { startDate: date("2026-02-01"), endDate: date("2026-01-31") }));
    await makeContract("saas", { startDate: date("2026-02-01"), endDate: date("2026-02-01") });
    const open = await makeContract("saas");
    expect(open.endDate).toBeNull();
  });

  it("lets a saas contract have neither an SLA nor an hour package (AC-2.8, A15)", async () => {
    const contract = await makeContract("saas");
    expect(contract).toMatchObject({ slaHighDays: null, hourPackageHours: null, origin: "manual", version: 1 });
  });

  it("comes from at most one contract per won deal", async () => {
    await makeContract("saas", { dealId: "deal-1" });
    await refused(makeContract("saas", { dealId: "deal-1" })).toBeDefined();
    await makeContract("saas", { dealId: "deal-2" });
  });
});

describe("contract position (AC-2.7)", () => {
  it("needs planned man-days above zero and a profile name", async () => {
    const contract = await makeContract("t_and_m");
    const position = (over: Partial<Prisma.ContractPositionUncheckedCreateInput>) =>
      db.contractPosition.create({
        data: { contractId: contract.id, profile: "Senior developer", plannedManDays: "12.5", position: 0, ...over },
      });
    await refusedBy("contract_position_man_days_positive", position({ plannedManDays: "0" }));
    await refusedBy("contract_position_profile_not_blank", position({ profile: " " }));
    expect((await position({})).plannedManDays.toString()).toBe("12.5");
  });

  it("goes with its contract", async () => {
    const contract = await makeContract("t_and_m");
    await db.contractPosition.create({ data: { contractId: contract.id, profile: "QA", plannedManDays: "3", position: 0 } });
    await db.contract.delete({ where: { id: contract.id } });
    expect(await db.contractPosition.count()).toBe(0);
  });
});

describe("ids", () => {
  it("are text everywhere, never uuid (CRM and auth ids are cuids)", async () => {
    const columns = await db.$queryRaw<{ table_name: string; column_name: string; data_type: string }[]>`
      SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'
        AND column_name IN ('id', 'projectId', 'companyId', 'projectManagerId', 'createdById', 'userId', 'contractId', 'dealId')`;
    expect(columns.length).toBeGreaterThan(8);
    for (const column of columns) {
      expect(`${column.table_name}.${column.column_name}: ${column.data_type}`).toBe(`${column.table_name}.${column.column_name}: text`);
    }
    const project = await makeProject();
    expect(project.id).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});
