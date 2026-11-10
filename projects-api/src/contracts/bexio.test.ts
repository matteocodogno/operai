/**
 * The Bexio order id of a contract (specs/025 T9; AC-3.1, AC-3.2, AC-3.3, AC-4.5). Runs the
 * ASSEMBLED app against the `*_test` database; auth and the CRM are the fakes of
 * test-support/world.ts. Projects and contracts are seeded straight in the database.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { call, crm, db, resetWorld, type PersonaName } from "../test-support/world";
import type { Prisma } from "../lib/generated/prisma/client";

beforeEach(async () => {
  await resetWorld();
  crm.companies = [{ id: "co-acme", name: "Acme SA", entity: "welld_ch", archived: false }];
});

const seedProject = (over: Partial<Prisma.ProjectUncheckedCreateInput> = {}) =>
  db.project.create({
    data: {
      name: "Website",
      type: "fixed_price",
      entity: "welld_ch",
      companyId: "co-acme",
      projectManagerId: "user-pm-ch",
      createdById: "user-pm-ch",
      ...over,
    },
  });

const seedContract = (projectId: string, over: Partial<Prisma.ContractUncheckedCreateInput> = {}) =>
  db.contract.create({
    data: {
      projectId,
      type: "fixed_price",
      companyId: "co-acme",
      startDate: new Date("2026-12-01T00:00:00Z"),
      deadline: new Date("2027-03-31T00:00:00Z"),
      maxEffortManDays: 55.5,
      ...over,
    },
  });

/** A project with one contract and no Bexio order id. */
async function fixture(project: Partial<Prisma.ProjectUncheckedCreateInput> = {}) {
  const p = await seedProject(project);
  return { project: p, contract: await seedContract(p.id) };
}

const putBexio = (
  projectId: string,
  contractId: string,
  body: unknown,
  as: PersonaName | null = "accounting",
  ifMatch: number | string = 1,
) => call("PUT", `/projects/${projectId}/contracts/${contractId}/bexio-order`, { as, body, ifMatch });

const bexioOf = async (contractId: string) => (await db.contract.findUniqueOrThrow({ where: { id: contractId } })).bexioOrderId;

describe("PUT /projects/:id/contracts/:contractId/bexio-order — accounting writes it (AC-3.1, AC-3.2)", () => {
  it("sets, changes and clears it: 200 with the Contract, the new ETag and version each time", async () => {
    const { project, contract } = await fixture();
    expect(contract.bexioOrderId).toBeNull();

    const set = await putBexio(project.id, contract.id, { bexioOrderId: "AB-2026-0042" });
    expect(set.status).toBe(200);
    expect(set.headers.get("ETag")).toBe('"2"');
    expect(set.json).toMatchObject({ id: contract.id, projectId: project.id, bexioOrderId: "AB-2026-0042", version: 2 });
    expect(await bexioOf(contract.id)).toBe("AB-2026-0042");

    const changed = await putBexio(project.id, contract.id, { bexioOrderId: "AB-2026-0043" }, "accounting", 2);
    expect(changed.status).toBe(200);
    expect(changed.json).toMatchObject({ bexioOrderId: "AB-2026-0043", version: 3 });

    const cleared = await putBexio(project.id, contract.id, { bexioOrderId: null }, "accounting", 3);
    expect(cleared.status).toBe(200);
    expect(cleared.json).toMatchObject({ bexioOrderId: null, version: 4 });
    expect(await bexioOf(contract.id)).toBeNull();
  });

  it("shows it on the contract and on the project page's contract list", async () => {
    const { project, contract } = await fixture();
    await putBexio(project.id, contract.id, { bexioOrderId: "AB-1" });
    expect((await call("GET", `/projects/${project.id}/contracts/${contract.id}`, { as: "viewer" })).json.bexioOrderId).toBe("AB-1");
    const page = await call("GET", `/projects/${project.id}`, { as: "viewer" });
    expect(page.json.contracts.map((c: { bexioOrderId: string | null }) => c.bexioOrderId)).toEqual(["AB-1"]);
  });

  it("trims the value, and turns an empty or blank one into `null` (AC-3.2)", async () => {
    const { project, contract } = await fixture();
    const trimmed = await putBexio(project.id, contract.id, { bexioOrderId: "  AB-7 \t" });
    expect(trimmed.json.bexioOrderId).toBe("AB-7");
    for (const [index, blank] of ["", "   "].entries()) {
      const res = await putBexio(project.id, contract.id, { bexioOrderId: blank }, "accounting", 2 + index);
      expect(res.status).toBe(200);
      expect(res.json.bexioOrderId).toBeNull();
    }
    expect(await bexioOf(contract.id)).toBeNull();
  });

  it("takes 64 characters and refuses 65: 400 naming the field, unchanged (AC-3.2)", async () => {
    const { project, contract } = await fixture();
    const max = await putBexio(project.id, contract.id, { bexioOrderId: "x".repeat(64) });
    expect(max.status).toBe(200);
    expect(max.json.bexioOrderId).toBe("x".repeat(64));
    // Length is of the trimmed value: padding does not count against the limit.
    expect((await putBexio(project.id, contract.id, { bexioOrderId: ` ${"y".repeat(64)} ` }, "accounting", 2)).status).toBe(200);
    const over = await putBexio(project.id, contract.id, { bexioOrderId: "z".repeat(65) }, "accounting", 3);
    expect(over.status).toBe(400);
    expect(over.json).toMatchObject({ status: 400, code: "validation_failed", field: "bexioOrderId" });
    expect(await bexioOf(contract.id)).toBe("y".repeat(64));
  });

  it.each([
    { what: "no bexioOrderId member", body: {} },
    { what: "a number", body: { bexioOrderId: 42 } },
    { what: "an unknown member", body: { bexioOrderId: "AB-1", startDate: "2026-12-01" } },
  ])("refuses $what: 400", async ({ body }) => {
    const { project, contract } = await fixture();
    const res = await putBexio(project.id, contract.id, body);
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: "validation_failed" });
    expect(await bexioOf(contract.id)).toBeNull();
  });

  it("is free text: not checked for uniqueness, the same id may sit on two contracts (AC-3.2)", async () => {
    const { project, contract } = await fixture();
    const second = await seedContract(project.id);
    expect((await putBexio(project.id, contract.id, { bexioOrderId: "AB-1" })).status).toBe(200);
    expect((await putBexio(project.id, second.id, { bexioOrderId: "AB-1" })).status).toBe(200);
  });

  it("leaves the contract's other facts alone", async () => {
    const { project, contract } = await fixture();
    const res = await putBexio(project.id, contract.id, { bexioOrderId: "AB-1" });
    expect(res.json).toMatchObject({
      startDate: "2026-12-01",
      endDate: null,
      terms: { deadline: "2027-03-31", estimatedManDays: null, maxEffortManDays: 55.5 },
    });
  });

  it("works on a contract of either entity and of a closed project: the capability is not entity-scoped", async () => {
    const itProject = await seedProject({ entity: "welld_it", name: "IT" });
    const itContract = await seedContract(itProject.id);
    expect((await putBexio(itProject.id, itContract.id, { bexioOrderId: "AB-IT" })).status).toBe(200);
    const closed = await seedProject({ state: "closed", name: "Closed" });
    const closedContract = await seedContract(closed.id);
    expect((await putBexio(closed.id, closedContract.id, { bexioOrderId: "AB-OLD" })).status).toBe(200);
  });
});

describe("PUT …/bexio-order — who may (AC-3.1, AC-4.5)", () => {
  it.each(["pmCh", "salesIt", "viewer", "colleague"] as const)(
    "refuses %s, who does not hold the Bexio-order capability: 403 `forbidden`, even with a bad body, and nothing changes",
    async (as) => {
      const { project, contract } = await fixture();
      const res = await putBexio(project.id, contract.id, { bexioOrderId: "AB-1" }, as);
      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({ status: 403, code: "forbidden" });
      expect((await putBexio(project.id, contract.id, { nope: true }, as)).status).toBe(403);
      expect(await bexioOf(contract.id)).toBeNull();
      expect((await db.contract.findUniqueOrThrow({ where: { id: contract.id } })).version).toBe(1);
    },
  );

  it("refuses the caller with no module access (403) and no token (401) (AC-4.2)", async () => {
    const { project, contract } = await fixture();
    expect((await putBexio(project.id, contract.id, { bexioOrderId: "AB-1" }, "outsider")).status).toBe(403);
    expect((await putBexio(project.id, contract.id, { bexioOrderId: "AB-1" }, null)).status).toBe(401);
  });

  it("lets an admin write it too", async () => {
    const { project, contract } = await fixture();
    expect((await putBexio(project.id, contract.id, { bexioOrderId: "AB-ADM" }, "admin")).status).toBe(200);
  });

  it("does not let a project manager's terms edit sneak it in (the PATCH has no such member)", async () => {
    const { project, contract } = await fixture();
    const res = await call("PATCH", `/projects/${project.id}/contracts/${contract.id}`, {
      as: "pmCh",
      body: { bexioOrderId: "AB-1" },
      ifMatch: 1,
    });
    expect(res.status).toBe(400);
    expect(await bexioOf(contract.id)).toBeNull();
  });
});

describe("PUT …/bexio-order — concurrency and lookup (AC-1.7)", () => {
  it("is 428 without `If-Match`", async () => {
    const { project, contract } = await fixture();
    const res = await call("PUT", `/projects/${project.id}/contracts/${contract.id}/bexio-order`, {
      as: "accounting",
      body: { bexioOrderId: "AB-1" },
    });
    expect(res.status).toBe(428);
    expect(res.json).toMatchObject({ code: "precondition_required" });
  });

  it("is 409 `version_conflict` with the current version for a stale one, and a terms edit made meanwhile is not lost", async () => {
    const { project, contract } = await fixture();
    // A project manager ends the contract while accounting still has version 1 open.
    await call("PATCH", `/projects/${project.id}/contracts/${contract.id}`, {
      as: "pmCh",
      body: { endDate: "2027-01-31" },
      ifMatch: 1,
    });
    const res = await putBexio(project.id, contract.id, { bexioOrderId: "AB-1" });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ status: 409, code: "version_conflict", currentVersion: 2 });
    expect(await bexioOf(contract.id)).toBeNull();
    // Accounting reloads and saves again.
    expect((await putBexio(project.id, contract.id, { bexioOrderId: "AB-1" }, "accounting", 2)).status).toBe(200);
  });

  it("lets exactly one of two simultaneous saves of the same version win", async () => {
    const { project, contract } = await fixture();
    const [a, b] = await Promise.all([
      putBexio(project.id, contract.id, { bexioOrderId: "AB-A" }),
      putBexio(project.id, contract.id, { bexioOrderId: "AB-B" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await db.contract.findUniqueOrThrow({ where: { id: contract.id } })).version).toBe(2);
  });

  it("is 404 for an unknown contract, one of another project, and an unknown project", async () => {
    const { project, contract } = await fixture();
    const other = await seedProject({ name: "Other" });
    expect((await putBexio(project.id, "nope", { bexioOrderId: "AB-1" })).status).toBe(404);
    expect((await putBexio(other.id, contract.id, { bexioOrderId: "AB-1" })).status).toBe(404);
    expect((await putBexio("nope", contract.id, { bexioOrderId: "AB-1" })).status).toBe(404);
  });
});

describe("a missing Bexio order id blocks nothing (AC-3.3)", () => {
  const transition = (projectId: string, to: string, ifMatch: number) =>
    call("POST", `/projects/${projectId}/transitions`, { as: "pmCh", body: { to }, ifMatch });

  it("moves a project whose contracts have no Bexio order id planned → active → closed", async () => {
    const project = await seedProject();
    const first = await seedContract(project.id);
    await seedContract(project.id);
    expect(first.bexioOrderId).toBeNull();

    const started = await transition(project.id, "active", 1);
    expect(started.status).toBe(200);
    expect(started.json).toMatchObject({ state: "active", version: 2 });
    const closed = await transition(project.id, "closed", 2);
    expect(closed.status).toBe(200);
    expect(closed.json).toMatchObject({ state: "closed", version: 3 });
    expect(closed.json.contracts.map((c: { bexioOrderId: string | null }) => c.bexioOrderId)).toEqual([null, null]);
  });

  it("takes a new contract without an id on a planned project, and accounting may add it afterwards", async () => {
    const project = await seedProject();
    const res = await call("POST", `/projects/${project.id}/contracts`, {
      as: "pmCh",
      body: { startDate: "2026-12-01", terms: { deadline: "2027-03-31", maxEffortManDays: 10 } },
    });
    expect(res.status).toBe(201);
    expect(res.json.bexioOrderId).toBeNull();
    expect((await putBexio(project.id, res.json.id, { bexioOrderId: "AB-LATE" })).status).toBe(200);
  });
});
