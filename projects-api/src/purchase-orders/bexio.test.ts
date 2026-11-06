/**
 * The Bexio order id of a purchase order (specs/021 T9 as renamed by specs/022 T23; AC-3.1, AC-3.2,
 * AC-3.3, AC-4.5, AC-5.2). Runs the ASSEMBLED app against the `*_test` database; auth and the CRM are
 * the fakes of test-support/world.ts. Projects and purchase orders are seeded straight in the database.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { call, crm, db, makeDeal, resetWorld, seedDealProject, type PersonaName } from "../test-support/world";

beforeEach(async () => {
  await resetWorld();
  crm.companies = [{ id: "co-acme", name: "Acme SA", entity: "welld_ch", archived: false }];
  crm.deals = [makeDeal({ id: "deal-seed", title: "Website" })];
});

/** A project made from a deal, with its purchase order and no Bexio order id. */
const fixture = (project: Parameters<typeof seedDealProject>[0] = {}) => seedDealProject(project);

const putBexio = (projectId: string, body: unknown, as: PersonaName | null = "accounting", ifMatch: number | string = 1) =>
  call("PUT", `/projects/${projectId}/purchase-order/bexio-order`, { as, body, ifMatch });

const bexioOf = async (orderId: string) => (await db.purchaseOrder.findUniqueOrThrow({ where: { id: orderId } })).bexioOrderId;

describe("PUT /projects/:id/purchase-order/bexio-order — accounting writes it (AC-3.1, AC-3.2)", () => {
  it("sets, changes and clears it: 200 with the PurchaseOrder, the new ETag and version each time", async () => {
    const { project, order } = await fixture();
    expect(order.bexioOrderId).toBeNull();

    const set = await putBexio(project.id, { bexioOrderId: "AB-2026-0042" });
    expect(set.status).toBe(200);
    expect(set.headers.get("ETag")).toBe('"2"');
    expect(set.json).toMatchObject({ id: order.id, bexioOrderId: "AB-2026-0042", version: 2 });
    expect(await bexioOf(order.id)).toBe("AB-2026-0042");

    const changed = await putBexio(project.id, { bexioOrderId: "AB-2026-0043" }, "accounting", 2);
    expect(changed.status).toBe(200);
    expect(changed.json).toMatchObject({ bexioOrderId: "AB-2026-0043", version: 3 });

    const cleared = await putBexio(project.id, { bexioOrderId: null }, "accounting", 3);
    expect(cleared.status).toBe(200);
    expect(cleared.json).toMatchObject({ bexioOrderId: null, version: 4 });
    expect(await bexioOf(order.id)).toBeNull();
  });

  it("answers the PurchaseOrder shape: the deal live, no estimate here, no referent yet, the ops-manager (specs/022 § API contracts)", async () => {
    const { project, order } = await fixture({ order: { opsManagerId: "user-ops" } });
    const res = await putBexio(project.id, { bexioOrderId: "AB-1" });
    expect(res.json).toEqual({
      id: order.id,
      deal: { id: "deal-seed", title: "Website", won: true },
      estimate: null,
      bexioOrderId: "AB-1",
      referent: null,
      opsManager: { id: "user-ops", name: "Name of user-ops", deleted: false },
      version: 2,
    });
  });

  it("shows it on the project page's purchase order", async () => {
    const { project } = await fixture();
    await putBexio(project.id, { bexioOrderId: "AB-1" });
    const page = await call("GET", `/projects/${project.id}`, { as: "viewer" });
    expect(page.json.purchaseOrder.bexioOrderId).toBe("AB-1");
  });

  it("trims the value, and turns an empty or blank one into `null` (AC-3.2)", async () => {
    const { project, order } = await fixture();
    const trimmed = await putBexio(project.id, { bexioOrderId: "  AB-7 \t" });
    expect(trimmed.json.bexioOrderId).toBe("AB-7");
    for (const [index, blank] of ["", "   "].entries()) {
      const res = await putBexio(project.id, { bexioOrderId: blank }, "accounting", 2 + index);
      expect(res.status).toBe(200);
      expect(res.json.bexioOrderId).toBeNull();
    }
    expect(await bexioOf(order.id)).toBeNull();
  });

  it("takes 64 characters and refuses 65: 400 naming the field, unchanged (AC-3.2)", async () => {
    const { project, order } = await fixture();
    const max = await putBexio(project.id, { bexioOrderId: "x".repeat(64) });
    expect(max.status).toBe(200);
    expect(max.json.bexioOrderId).toBe("x".repeat(64));
    // Length is of the trimmed value: padding does not count against the limit.
    expect((await putBexio(project.id, { bexioOrderId: ` ${"y".repeat(64)} ` }, "accounting", 2)).status).toBe(200);
    const over = await putBexio(project.id, { bexioOrderId: "z".repeat(65) }, "accounting", 3);
    expect(over.status).toBe(400);
    expect(over.json).toMatchObject({ status: 400, code: "validation_failed", field: "bexioOrderId" });
    expect(await bexioOf(order.id)).toBe("y".repeat(64));
  });

  it.each([
    { what: "no bexioOrderId member", body: {} },
    { what: "a number", body: { bexioOrderId: 42 } },
    { what: "an unknown member", body: { bexioOrderId: "AB-1", startDate: "2026-12-01" } },
  ])("refuses $what: 400", async ({ body }) => {
    const { project, order } = await fixture();
    const res = await putBexio(project.id, body);
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: "validation_failed" });
    expect(await bexioOf(order.id)).toBeNull();
  });

  it("is free text: not checked for uniqueness, the same id may sit on two purchase orders (AC-3.2)", async () => {
    const first = await fixture();
    const second = await fixture({ order: { dealId: "deal-other" }, project: { name: "Second" } });
    expect((await putBexio(first.project.id, { bexioOrderId: "AB-1" })).status).toBe(200);
    expect((await putBexio(second.project.id, { bexioOrderId: "AB-1" })).status).toBe(200);
  });

  it("leaves the project and its terms alone", async () => {
    const { project, terms } = await fixture();
    await putBexio(project.id, { bexioOrderId: "AB-1" });
    expect(await db.project.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({ version: 1 });
    expect(await db.projectTerms.findUniqueOrThrow({ where: { id: terms.id } })).toMatchObject({ version: 1 });
  });

  it("works on a purchase order of either entity and of a closed project: the capability is not entity-scoped", async () => {
    const it = await fixture({ project: { entity: "welld_it", name: "IT" }, order: { dealId: "deal-it" } });
    expect((await putBexio(it.project.id, { bexioOrderId: "AB-IT" })).status).toBe(200);
    const closed = await fixture({ project: { state: "closed", name: "Closed" }, order: { dealId: "deal-old" } });
    expect((await putBexio(closed.project.id, { bexioOrderId: "AB-OLD" })).status).toBe(200);
  });
});

describe("PUT …/purchase-order/bexio-order — a hand-made project has no purchase order (AC-5.2, D38)", () => {
  const handMade = () =>
    db.project.create({
      data: { name: "By hand", type: "fixed_price", entity: "welld_ch", companyId: "co-acme", projectManagerId: "user-pm-ch", createdById: "user-pm-ch" },
    });

  it("is 404 `purchase_order_not_found`, for accounting and an admin alike, and creates nothing", async () => {
    const project = await handMade();
    for (const as of ["accounting", "admin"] as const) {
      const res = await putBexio(project.id, { bexioOrderId: "AB-1" }, as);
      expect(res.status).toBe(404);
      expect(res.json).toMatchObject({ status: 404, code: "purchase_order_not_found" });
    }
    expect(await db.purchaseOrder.count()).toBe(0);
  });

  it("is 404 for an unknown project", async () => {
    expect((await putBexio("nope", { bexioOrderId: "AB-1" })).status).toBe(404);
  });
});

describe("PUT …/bexio-order — who may (AC-3.1, AC-4.5)", () => {
  it.each(["pmCh", "salesIt", "viewer", "colleague"] as const)(
    "refuses %s, who does not hold the Bexio-order capability: 403 `forbidden`, even with a bad body, and nothing changes",
    async (as) => {
      const { project, order } = await fixture();
      const res = await putBexio(project.id, { bexioOrderId: "AB-1" }, as);
      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({ status: 403, code: "forbidden" });
      expect((await putBexio(project.id, { nope: true }, as)).status).toBe(403);
      expect(await bexioOf(order.id)).toBeNull();
      expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).version).toBe(1);
    },
  );

  it("refuses the caller with no module access (403) and no token (401) (AC-4.2)", async () => {
    const { project } = await fixture();
    expect((await putBexio(project.id, { bexioOrderId: "AB-1" }, "outsider")).status).toBe(403);
    expect((await putBexio(project.id, { bexioOrderId: "AB-1" }, null)).status).toBe(401);
  });

  it("lets an admin write it too", async () => {
    const { project } = await fixture();
    expect((await putBexio(project.id, { bexioOrderId: "AB-ADM" }, "admin")).status).toBe(200);
  });

  it("does not let a project manager's terms edit sneak it in (the PATCH has no such member)", async () => {
    const { project, order } = await fixture();
    const res = await call("PATCH", `/projects/${project.id}/terms`, { as: "pmCh", body: { bexioOrderId: "AB-1" }, ifMatch: 1 });
    expect(res.status).toBe(400);
    expect(await bexioOf(order.id)).toBeNull();
  });
});

describe("PUT …/bexio-order — concurrency (AC-1.7)", () => {
  it("is 428 without `If-Match`", async () => {
    const { project } = await fixture();
    const res = await call("PUT", `/projects/${project.id}/purchase-order/bexio-order`, {
      as: "accounting",
      body: { bexioOrderId: "AB-1" },
    });
    expect(res.status).toBe(428);
    expect(res.json).toMatchObject({ code: "precondition_required" });
  });

  it("is 409 `version_conflict` with the current version for a stale one", async () => {
    const { project, order } = await fixture();
    expect((await putBexio(project.id, { bexioOrderId: "AB-1" })).status).toBe(200);
    const res = await putBexio(project.id, { bexioOrderId: "AB-2" });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ status: 409, code: "version_conflict", currentVersion: 2 });
    expect(await bexioOf(order.id)).toBe("AB-1");
    // Accounting reloads and saves again.
    expect((await putBexio(project.id, { bexioOrderId: "AB-2" }, "accounting", 2)).status).toBe(200);
  });

  it("lets exactly one of two simultaneous saves of the same version win", async () => {
    const { project, order } = await fixture();
    const [a, b] = await Promise.all([putBexio(project.id, { bexioOrderId: "AB-A" }), putBexio(project.id, { bexioOrderId: "AB-B" })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).version).toBe(2);
  });
});

describe("a missing Bexio order id blocks nothing (AC-3.3)", () => {
  const transition = (projectId: string, to: string, ifMatch: number) =>
    call("POST", `/projects/${projectId}/transitions`, { as: "pmCh", body: { to }, ifMatch });

  it("moves a project whose purchase order has no Bexio order id planned → active → closed", async () => {
    // With a project manager already picked: starting a project that still awaits one is T27's rule (D48).
    const { project, order } = await fixture({ project: { projectManagerId: "user-pm-ch" } });
    expect(order.bexioOrderId).toBeNull();

    const started = await transition(project.id, "active", 1);
    expect(started.status).toBe(200);
    expect(started.json).toMatchObject({ state: "active", version: 2 });
    const closed = await transition(project.id, "closed", 2);
    expect(closed.status).toBe(200);
    expect(closed.json).toMatchObject({ state: "closed", version: 3 });
    expect(closed.json.purchaseOrder.bexioOrderId).toBeNull();
  });
});
