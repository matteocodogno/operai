/**
 * `PATCH /assets/{id}` (T13, specs/015-hardware-inventory; AC-1.9, AC-3.6,
 * AC-5.9, AC-10.1, AC-11.1). Real router + middleware over the harness, real
 * Postgres; `auth` identities are stubbed.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, spyOn } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { setupTestAuth } from "../test-support/testAuth";
import type { ResolvedPermission } from "../authz/resolveClient";
import { truncateInventoryTables } from "../test-support/dbCleanup";

const harness = setupTestAuth();
await harness.init();

const { db } = await import("../lib/db");
const { handleProblemError } = await import("../lib/problem");
const { assetEditRouter } = await import("./edit.routes");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { __resetIdentityCacheForTests } = await import("../lib/identities");
const { lockEntity } = await import("../fiscal-years/guard");
const { eventChanges } = await import("../history/record");

const app = new OpenAPIHono();
app.route("/", assetEditRouter);
app.onError((err, c) => handleProblemError(err, c.req.path) ?? c.json({ error: String(err) }, 500));

const ENTITY: ResolvedPermission["conditions"] = {
  attributes: [{ key: "entity", match: "user" }],
};
const grant = (
  resource: string,
  action: string,
  conditions: ResolvedPermission["conditions"] = null,
): ResolvedPermission => ({ resource, action, conditions });
const resolving =
  (permissions: ResolvedPermission[], entity: string | null) => async () => ({
    sub: "u",
    epoch: 1,
    permissions,
    entity,
    jobTitle: null,
  });

const MANAGER = [grant("asset", "manage", ENTITY)];
const ACCOUNTANT = [grant("ledger", "manage", ENTITY)];
const BOTH = [...MANAGER, ...ACCOUNTANT];

let token: string;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

function as(permissions: ResolvedPermission[], entity: string | null) {
  __resetAuthzCacheForTests();
  harness.setResolve(resolving(permissions, entity));
}

beforeAll(async () => {
  token = await harness.signToken({ sub: "mgr-1", email: "mgr1@welld.ch", permEpoch: 1 });
});
beforeEach(async () => {
  await truncateInventoryTables();
  __resetAuthzCacheForTests();
  __resetIdentityCacheForTests();
  as(MANAGER, "welld_ch");
  fetchSpy = spyOn(globalThis, "fetch");
  fetchSpy.mockImplementation((async (_url: unknown, init?: RequestInit) => {
    const ids = (JSON.parse(String(init?.body)) as { ids: string[] }).ids;
    return Response.json({
      users: ids.map((id) => ({ id, status: "active", name: `Name of ${id}` })),
    });
  }) as unknown as typeof fetch);
});
afterAll(async () => {
  fetchSpy?.mockRestore();
  await truncateInventoryTables();
});

const patch = (id: string, body: unknown) =>
  app.request(`/assets/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

type View = Record<string, any> & { id: string };
const viewOf = async (res: Response) => (await res.json()) as View;
const problemOf = async (res: Response) => (await res.json()) as Record<string, unknown>;

let seq = 0;
async function seed(over: Record<string, unknown> = {}) {
  seq++;
  return db.asset.create({
    data: {
      entity: "welld_ch",
      currency: "CHF",
      category: "laptop",
      description: `Device ${seq}`,
      purchaseDate: new Date("2026-03-01"),
      purchasePriceCents: 99815,
      status: "in_stock",
      createdByUserId: "seed",
      ...over,
    } as never,
  });
}
const closeYear = (year: number, entity: "welld_ch" | "welld_it" = "welld_ch") =>
  db.fiscalYear.create({
    data: {
      entity,
      year,
      openingCents: 0,
      disposalsCents: 0,
      purchasesCents: 0,
      depreciationCents: 0,
      closingCents: 0,
      source: "closed",
      closedByUserId: "acc",
    },
  });
const eventsOf = (assetId: string) =>
  db.assetEvent.findMany({ where: { assetId }, orderBy: { createdAt: "asc" } });

describe("PATCH /assets/{id}: location note and plain fields (AC-3.6)", () => {
  it("changes the note and leaves status and holder alone", async () => {
    const a = await seed({ status: "assigned", holderUserId: "emp-1" });
    const res = await patch(a.id, { locationNote: "Drawer 3" });
    expect(res.status).toBe(200);
    const v = await viewOf(res);
    expect(v["locationNote"]).toBe("Drawer 3");
    expect(v["status"]).toBe("assigned");
    expect(v["holder"]).toMatchObject({ id: "emp-1" });
    const row = await db.asset.findUniqueOrThrow({ where: { id: a.id } });
    expect([row.status, row.holderUserId]).toEqual(["assigned", "emp-1"]);
  });

  it("records one `edited` event whose typed changes list only what changed", async () => {
    const a = await seed({ supplier: "Acme", description: "Same" });
    const res = await patch(a.id, { description: "Same", supplier: "Dell", locationNote: "Shelf" });
    expect(res.status).toBe(200);
    const events = await eventsOf(a.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "edited", actorUserId: "mgr-1", entity: "welld_ch" });
    expect(eventChanges(events[0]!.oldValue, events[0]!.newValue)).toEqual([
      { field: "locationNote", from: null, to: "Shelf" },
      { field: "supplier", from: "Acme", to: "Dell" },
    ]);
  });

  it("a patch that changes nothing returns the asset and writes no event", async () => {
    const a = await seed({ description: "Same" });
    const res = await patch(a.id, { description: "Same" });
    expect(res.status).toBe(200);
    expect(await eventsOf(a.id)).toHaveLength(0);
  });

  it("clearing toVerify on its own is a `verified` event", async () => {
    const a = await seed({ toVerify: true });
    const res = await patch(a.id, { toVerify: false });
    expect((await viewOf(res))["toVerify"]).toBe(false);
    const [e] = await eventsOf(a.id);
    expect(e?.action).toBe("verified");
    expect(eventChanges(e!.oldValue, e!.newValue)).toEqual([{ field: "toVerify", from: true, to: false }]);
  });

  it("blank text clears an optional field; description cannot be blank", async () => {
    const a = await seed({ supplier: "Acme", locationNote: "x" });
    const ok = await viewOf(await patch(a.id, { supplier: "  ", locationNote: null }));
    expect(ok["supplier"]).toBeNull();
    expect(ok["locationNote"]).toBeNull();
    const bad = await patch(a.id, { description: "   " });
    expect(bad.status).toBe(422);
    expect((await problemOf(bad))["field"]).toBe("description");
  });
});

describe("PATCH /assets/{id}: what cannot be edited (AC-1.9)", () => {
  it("entity and currency are refused with 422 naming the field, and nothing changes", async () => {
    const a = await seed();
    for (const field of ["entity", "currency"]) {
      const res = await patch(a.id, { description: "Changed", [field]: "welld_it" });
      expect(res.status).toBe(422);
      expect((await problemOf(res))["field"]).toBe(field);
    }
    const row = await db.asset.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.description).toBe(a.description);
  });

  it("any other unknown field is a 422 naming it; so are status and holder", async () => {
    const a = await seed();
    for (const field of ["bogus", "status", "holderUserId"]) {
      const res = await patch(a.id, { [field]: "x" });
      expect(res.status).toBe(422);
      expect((await problemOf(res))["field"]).toBe(field);
    }
  });

  it("an empty body is a 422", async () => {
    const a = await seed();
    expect((await patch(a.id, {})).status).toBe(422);
  });

  it("price and date are validated", async () => {
    const a = await seed();
    for (const body of [
      { purchasePriceCents: 0 },
      { purchasePriceCents: 1.5 },
      { purchaseDate: "2026-02-30" },
      { purchaseDate: "1999-12-31" },
    ]) {
      expect((await patch(a.id, body)).status).toBe(422);
    }
  });

  it("a disposed asset accepts no edit: 409 asset_disposed", async () => {
    const a = await seed({
      status: "disposed",
      disposedOn: new Date("2026-06-01"),
      disposalReason: "scrapped",
    });
    const res = await patch(a.id, { locationNote: "x" });
    expect(res.status).toBe(409);
    expect(await problemOf(res)).toMatchObject({ code: "asset_disposed", assetId: a.id });
    expect(await eventsOf(a.id)).toHaveLength(0);
  });
});

describe("PATCH /assets/{id}: price and purchase date (AC-5.9)", () => {
  it("with every year open, the schedule is recomputed from the new price", async () => {
    as(BOTH, "welld_ch");
    const a = await seed({ purchaseDate: new Date("2026-09-25") });
    const res = await patch(a.id, { purchasePriceCents: 200100 });
    expect(res.status).toBe(200);
    const v = await viewOf(res);
    expect(v["purchasePriceCents"]).toBe(200100);
    expect(v["ledger"].schedule[0]).toMatchObject({ year: 2026, depreciationCents: 66667 });
    const [e] = await eventsOf(a.id);
    expect(eventChanges(e!.oldValue, e!.newValue)).toEqual([
      { field: "purchasePriceCents", from: 99815, to: 200100 },
    ]);
  });

  it("a new purchase date moves the schedule to the new first year", async () => {
    as(BOTH, "welld_ch");
    const a = await seed({ purchaseDate: new Date("2026-09-25") });
    const v = await viewOf(await patch(a.id, { purchaseDate: "2027-02-01" }));
    expect(v["purchaseDate"]).toBe("2027-02-01");
    expect(v["ledger"].schedule[0].year).toBe(2027);
  });

  it("is rejected when the old purchase year is closed", async () => {
    const a = await seed({ purchaseDate: new Date("2026-03-01") });
    await closeYear(2026);
    const res = await patch(a.id, { purchasePriceCents: 5000 });
    expect(res.status).toBe(409);
    expect(await problemOf(res)).toMatchObject({ code: "fiscal_year_closed", year: 2026 });
    const row = await db.asset.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.purchasePriceCents).toBe(99815);
    expect(await eventsOf(a.id)).toHaveLength(0);
  });

  it("is rejected when a closed year lies after the purchase year (closing is a prefix)", async () => {
    const a = await seed({ purchaseDate: new Date("2024-03-01") });
    await closeYear(2026);
    expect((await patch(a.id, { purchasePriceCents: 5000 })).status).toBe(409);
    expect((await patch(a.id, { purchaseDate: "2024-04-01" })).status).toBe(409);
  });

  it("is rejected when the NEW date falls in a closed year", async () => {
    const a = await seed({ purchaseDate: new Date("2027-01-10") });
    await closeYear(2026);
    const res = await patch(a.id, { purchaseDate: "2026-12-31" });
    expect(res.status).toBe(409);
    expect(await problemOf(res)).toMatchObject({ code: "fiscal_year_closed", year: 2026 });
  });

  it("an open-year asset can still move within open years while another year is closed", async () => {
    const a = await seed({ purchaseDate: new Date("2027-01-10") });
    await closeYear(2026);
    expect((await patch(a.id, { purchaseDate: "2028-05-05" })).status).toBe(200);
  });

  it("does not block non-dated fields in a closed year", async () => {
    const a = await seed({ purchaseDate: new Date("2024-03-01") });
    await closeYear(2026);
    expect((await patch(a.id, { locationNote: "Moved" })).status).toBe(200);
  });

  it("takes the entity lock before reading the closed boundary: a close in flight wins", async () => {
    const a = await seed({ purchaseDate: new Date("2026-03-01") });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const gotLock = new Promise<void>((r) => (locked = r));
    const closing = db.$transaction(async (tx) => {
      await lockEntity(tx, "welld_ch");
      locked();
      await held;
      await tx.fiscalYear.create({
        data: {
          entity: "welld_ch",
          year: 2026,
          openingCents: 0,
          disposalsCents: 0,
          purchasesCents: 0,
          depreciationCents: 0,
          closingCents: 0,
          source: "closed",
          closedByUserId: "acc",
        },
      });
    });
    await gotLock;
    const pending = patch(a.id, { purchasePriceCents: 5000 });
    await Bun.sleep(200);
    release();
    await closing;
    const res = await pending;
    expect(res.status).toBe(409);
    expect((await problemOf(res))["code"]).toBe("fiscal_year_closed");
  });
});

describe("PATCH /assets/{id}: serial number (AC-1.5)", () => {
  it("a serial held by another live asset of the entity is 409 serial_conflict with its id", async () => {
    const other = await seed({ serialNumber: "SN-1" });
    const a = await seed();
    const res = await patch(a.id, { serialNumber: "SN-1" });
    expect(res.status).toBe(409);
    expect(await problemOf(res)).toMatchObject({
      code: "serial_conflict",
      serialNumber: "SN-1",
      assetId: other.id,
    });
  });

  it("allows a serial of a disposed asset, the same serial in the other entity, and the asset's own", async () => {
    await seed({
      serialNumber: "SN-2",
      status: "disposed",
      disposedOn: new Date("2026-06-01"),
      disposalReason: "scrapped",
    });
    await seed({ serialNumber: "SN-3", entity: "welld_it", currency: "EUR" });
    const a = await seed({ serialNumber: "SN-4" });
    expect((await patch(a.id, { serialNumber: "SN-2" })).status).toBe(200);
    expect((await patch(a.id, { serialNumber: "SN-3" })).status).toBe(200);
    expect((await patch(a.id, { serialNumber: "SN-3" })).status).toBe(200);
  });

  it("serialNumber null clears it", async () => {
    const a = await seed({ serialNumber: "SN-9" });
    expect((await viewOf(await patch(a.id, { serialNumber: null })))["serialNumber"]).toBeNull();
  });

  it("when the pre-check passes but another writer commits the serial first, the unique index maps to 409 serial_conflict", async () => {
    const a = await seed();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const hasInserted = new Promise<void>((r) => (inserted = r));
    let rivalId = "";
    const rival = db.$transaction(async (tx) => {
      const r = await tx.asset.create({
        data: {
          entity: "welld_ch",
          currency: "CHF",
          category: "laptop",
          description: "Rival",
          serialNumber: "SN-RACE",
          purchaseDate: new Date("2026-03-01"),
          purchasePriceCents: 100,
          status: "in_stock",
          createdByUserId: "seed",
        },
      });
      rivalId = r.id;
      inserted();
      await held;
    });
    await hasInserted;
    const pending = patch(a.id, { serialNumber: "SN-RACE" });
    await Bun.sleep(200);
    release();
    await rival;
    const res = await pending;
    expect(res.status).toBe(409);
    expect(await problemOf(res)).toMatchObject({
      code: "serial_conflict",
      serialNumber: "SN-RACE",
      assetId: rivalId,
    });
    const row = await db.asset.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.serialNumber).toBeNull();
    expect(await eventsOf(a.id)).toHaveLength(0);
  });
});

describe("PATCH /assets/{id}: supplier, invoice reference and the file link (AC-10.1)", () => {
  it("stores supplier and invoice reference as their own fields", async () => {
    const a = await seed();
    const v = await viewOf(await patch(a.id, { supplier: "Apple", invoiceRef: "INV-7" }));
    expect(v).toMatchObject({ supplier: "Apple", invoiceRef: "INV-7" });
  });

  async function seedLinked() {
    const file = await db.invoiceFile.create({
      data: {
        entity: "welld_ch",
        invoiceRef: "INV-1",
        objectKey: `inventory/welld_ch/${Math.random()}/a.pdf`,
        fileName: "a.pdf",
        contentType: "application/pdf",
        sizeBytes: 10,
        uploadStatus: "stored",
        createdByUserId: "seed",
      },
    });
    const a = await seed({ invoiceRef: "INV-1", invoiceFileId: file.id });
    return { a, file };
  }

  it("changing the invoice reference unlinks the file and records it", async () => {
    const { a } = await seedLinked();
    const v = await viewOf(await patch(a.id, { invoiceRef: "INV-2" }));
    expect(v["invoiceFile"]).toBeNull();
    expect((await db.asset.findUniqueOrThrow({ where: { id: a.id } })).invoiceFileId).toBeNull();
    const actions = (await eventsOf(a.id)).map((e) => e.action).sort();
    expect(actions).toEqual(["edited", "invoice_file_linked"]);
  });

  it("re-sending the same reference keeps the link", async () => {
    const { a } = await seedLinked();
    const v = await viewOf(await patch(a.id, { invoiceRef: "INV-1", supplier: "S" }));
    expect(v["invoiceFile"]).toMatchObject({ fileName: "a.pdf" });
    expect(await eventsOf(a.id)).toHaveLength(1);
  });

  it("an accountant may patch supplier and invoiceRef only", async () => {
    as(ACCOUNTANT, "welld_ch");
    const a = await seed();
    const ok = await patch(a.id, { supplier: "Dell", invoiceRef: "INV-3" });
    expect(ok.status).toBe(200);
    expect(await viewOf(ok)).toMatchObject({ supplier: "Dell", invoiceRef: "INV-3" });
    for (const body of [
      { description: "x" },
      { supplier: "ok", purchasePriceCents: 5 },
      { locationNote: "x" },
      { toVerify: false },
      { serialNumber: "S" },
    ]) {
      const res = await patch(a.id, body);
      expect(res.status).toBe(403);
    }
    const row = await db.asset.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.supplier).toBe("Dell");
    expect(row.description).toBe(a.description);
  });

  it("an accountant's edit still sees the ledger on the response", async () => {
    as(ACCOUNTANT, "welld_ch");
    const a = await seed();
    const v = await viewOf(await patch(a.id, { supplier: "Dell" }));
    expect(v["ledger"]).toBeDefined();
  });

  it("a manager response carries no ledger", async () => {
    const a = await seed();
    const v = await viewOf(await patch(a.id, { supplier: "Dell" }));
    expect(v).not.toHaveProperty("ledger");
  });
});

describe("PATCH /assets/{id}: capability and scope", () => {
  it("no capability: 403", async () => {
    as([], "welld_ch");
    const a = await seed();
    expect((await patch(a.id, { supplier: "x" })).status).toBe(403);
  });

  it("unknown id and out-of-scope entity are both 404", async () => {
    const other = await seed({ entity: "welld_it", currency: "EUR" });
    expect((await patch(other.id, { supplier: "x" })).status).toBe(404);
    expect((await patch("nope", { supplier: "x" })).status).toBe(404);
  });

  it("an accountant whose ledger scope covers the entity but who lacks asset scope is 403 on manager fields, not 404", async () => {
    as([grant("asset", "manage", ENTITY), grant("ledger", "manage")], "welld_it");
    const a = await seed(); // welld_ch: ledger scope (all) but asset scope is welld_it only
    expect((await patch(a.id, { description: "x" })).status).toBe(403);
    expect((await patch(a.id, { supplier: "x" })).status).toBe(200);
  });

  it("requires a token", async () => {
    const a = await seed();
    const res = await app.request(`/assets/${a.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });
});
