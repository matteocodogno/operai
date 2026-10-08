/**
 * `POST /assets` (T11, specs/015-hardware-inventory; AC-1.1..1.7, AC-10.2).
 * Real router, real middleware over the harness, real Postgres.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { setupTestAuth } from "../test-support/testAuth";
import type { ResolvedPermission } from "../authz/resolveClient";
import { truncateInventoryTables } from "../test-support/dbCleanup";

const harness = setupTestAuth();
await harness.init();

const { db } = await import("../lib/db");
const { handleProblemError } = await import("../lib/problem");
const { assetRegisterRouter } = await import("./register.routes");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");

const app = new OpenAPIHono();
app.route("/", assetRegisterRouter);
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

let token: string;
beforeAll(async () => {
  token = await harness.signToken({ sub: "mgr-1", email: "mgr1@welld.ch", permEpoch: 1 });
});
beforeEach(async () => {
  await truncateInventoryTables();
  __resetAuthzCacheForTests();
  harness.setResolve(resolving([grant("asset", "manage")], "welld_ch"));
});
afterAll(async () => {
  await truncateInventoryTables();
});

const post = (body: unknown, bearer: string | null = token) =>
  app.request("/assets", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });

const valid = {
  entity: "welld_ch",
  category: "laptop",
  description: "MacBook Pro 14",
  purchaseDate: "2026-09-25",
  totalPriceCents: 99815,
};

type View = Record<string, unknown> & { id: string };
const assetsOf = async (res: Response) => ((await res.json()) as { assets: View[] }).assets;
const problemOf = async (res: Response) =>
  (await res.json()) as Record<string, unknown> & { code?: string; field?: string };

describe("POST /assets: the happy path", () => {
  it("registers an in_stock asset by default, currency CHF for welld_ch, as an AssetView", async () => {
    const res = await post({ ...valid, supplier: "Apple", invoiceRef: "INV-1", locationNote: "Shelf 2" });
    expect(res.status).toBe(201);
    const [a] = await assetsOf(res);
    expect(a).toMatchObject({
      entity: "welld_ch",
      currency: "CHF",
      category: "laptop",
      description: "MacBook Pro 14",
      serialNumber: null,
      purchaseDate: "2026-09-25",
      purchasePriceCents: 99815,
      status: "in_stock",
      holder: null,
      pendingAssignment: null,
      locationNote: "Shelf 2",
      supplier: "Apple",
      invoiceRef: "INV-1",
      invoiceFile: null,
      toVerify: false,
      disposal: null,
    });
    expect(a).not.toHaveProperty("ledger");
    const row = await db.asset.findUniqueOrThrow({ where: { id: a!.id } });
    expect(row.createdByUserId).toBe("mgr-1");
  });

  it("received=false registers as ordered", async () => {
    const [a] = await assetsOf(await post({ ...valid, received: false }));
    expect(a!["status"]).toBe("ordered");
  });

  it("currency follows the entity: welld_it is EUR", async () => {
    harness.setResolve(resolving([grant("asset", "manage")], "welld_it"));
    const [a] = await assetsOf(await post({ ...valid, entity: "welld_it" }));
    expect(a!["currency"]).toBe("EUR");
  });

  it("optional text is trimmed; blank becomes null", async () => {
    const [a] = await assetsOf(
      await post({ ...valid, description: "  Dock  ", supplier: "   ", invoiceRef: "" }),
    );
    expect(a!["description"]).toBe("Dock");
    expect(a!["supplier"]).toBeNull();
    expect(a!["invoiceRef"]).toBeNull();
  });

  it("writes exactly one `registered` event per asset", async () => {
    const assets = await assetsOf(await post({ ...valid, quantity: 3, totalPriceCents: 300 }));
    expect(assets).toHaveLength(3);
    const events = await db.assetEvent.findMany({ orderBy: { createdAt: "asc" } });
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.action === "registered" && e.actorUserId === "mgr-1")).toBe(true);
    expect(new Set(events.map((e) => e.assetId))).toEqual(new Set(assets.map((a) => a.id)));
    expect(events[0]?.actorEmail).toBe("mgr1@welld.ch");
  });
});

describe("POST /assets: quantity N", () => {
  it("creates N assets whose prices sum to the total, sharing supplier and invoice reference", async () => {
    const assets = await assetsOf(
      await post({ ...valid, quantity: 3, totalPriceCents: 100000, supplier: "Dell", invoiceRef: "INV-9" }),
    );
    expect(assets.map((a) => a["purchasePriceCents"])).toEqual([33333, 33333, 33334]);
    expect(assets.reduce((s, a) => s + (a["purchasePriceCents"] as number), 0)).toBe(100000);
    expect(new Set(assets.map((a) => a["supplier"]))).toEqual(new Set(["Dell"]));
    expect(new Set(assets.map((a) => a["invoiceRef"]))).toEqual(new Set(["INV-9"]));
    expect(await db.asset.count()).toBe(3);
  });

  it("serialNumbers are applied in order, one per unit", async () => {
    const assets = await assetsOf(
      await post({ ...valid, quantity: 2, totalPriceCents: 1000, serialNumbers: ["SN-A", "SN-B"] }),
    );
    expect(assets.map((a) => a["serialNumber"])).toEqual(["SN-A", "SN-B"]);
  });

  it("a total smaller than the quantity would give a zero-price unit -> 422 totalPriceCents, no rows", async () => {
    const res = await post({ ...valid, quantity: 5, totalPriceCents: 4 });
    expect(res.status).toBe(422);
    expect((await problemOf(res)).field).toBe("totalPriceCents");
    expect(await db.asset.count()).toBe(0);
  });

  it("quantity is 1..200", async () => {
    expect((await post({ ...valid, quantity: 0 })).status).toBe(422);
    expect((await post({ ...valid, quantity: 201, totalPriceCents: 100000 })).status).toBe(422);
    expect((await post({ ...valid, quantity: 200, totalPriceCents: 100000 })).status).toBe(201);
    expect(await db.asset.count()).toBe(200);
  });
});

describe("POST /assets: serial numbers", () => {
  it("wrong length -> 422 serial_count_mismatch and zero rows", async () => {
    const res = await post({ ...valid, quantity: 3, totalPriceCents: 300, serialNumbers: ["A", "B"] });
    expect(res.status).toBe(422);
    const body = await problemOf(res);
    expect(body.code).toBe("serial_count_mismatch");
    expect(body.field).toBe("serialNumbers");
    expect(await db.asset.count()).toBe(0);
  });

  it("an empty serialNumbers array is the same as none", async () => {
    const [a] = await assetsOf(await post({ ...valid, serialNumbers: [] }));
    expect(a!["serialNumber"]).toBeNull();
  });

  it("a blank serial -> 422 naming the element", async () => {
    const res = await post({ ...valid, serialNumbers: ["  "] });
    expect(res.status).toBe(422);
    expect((await problemOf(res)).field).toBe("serialNumbers.0");
  });

  it("a duplicate live serial in the same entity -> 409 serial_conflict with serialNumber and assetId", async () => {
    const [first] = await assetsOf(await post({ ...valid, serialNumbers: ["SN-1"] }));
    const res = await post({ ...valid, serialNumbers: ["SN-1"] });
    expect(res.status).toBe(409);
    const body = await problemOf(res);
    expect(body.code).toBe("serial_conflict");
    expect(body["serialNumber"]).toBe("SN-1");
    expect(body["assetId"]).toBe(first!.id);
    expect(await db.asset.count()).toBe(1);
  });

  it("a conflict on the second unit rolls back the first", async () => {
    await post({ ...valid, serialNumbers: ["SN-2"] });
    const res = await post({ ...valid, quantity: 2, totalPriceCents: 200, serialNumbers: ["NEW", "SN-2"] });
    expect(res.status).toBe(409);
    expect(await db.asset.count()).toBe(1);
    expect(await db.assetEvent.count()).toBe(1);
  });

  it("the same serial twice inside one request -> 409 serial_conflict (no assetId yet)", async () => {
    const res = await post({ ...valid, quantity: 2, totalPriceCents: 200, serialNumbers: ["DUP", "DUP"] });
    expect(res.status).toBe(409);
    const body = await problemOf(res);
    expect(body.code).toBe("serial_conflict");
    expect(body["serialNumber"]).toBe("DUP");
    expect(body).not.toHaveProperty("assetId");
    expect(await db.asset.count()).toBe(0);
  });

  it("the same serial in the other entity is fine", async () => {
    harness.setResolve(resolving([grant("asset", "manage")], "welld_ch"));
    await post({ ...valid, serialNumbers: ["SN-3"] });
    const res = await post({ ...valid, entity: "welld_it", serialNumbers: ["SN-3"] });
    expect(res.status).toBe(201);
  });

  it("the same serial is accepted again once the earlier asset is disposed", async () => {
    const [first] = await assetsOf(await post({ ...valid, serialNumbers: ["SN-4"] }));
    await db.asset.update({ where: { id: first!.id }, data: { status: "disposed", disposedOn: new Date("2026-10-01") } });
    expect((await post({ ...valid, serialNumbers: ["SN-4"] })).status).toBe(201);
  });
});

describe("POST /assets: validation", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["missing entity", { entity: undefined }, "entity"],
    ["missing category", { category: undefined }, "category"],
    ["missing description", { description: undefined }, "description"],
    ["blank description", { description: "   " }, "description"],
    ["missing purchaseDate", { purchaseDate: undefined }, "purchaseDate"],
    ["impossible purchaseDate", { purchaseDate: "2026-02-30" }, "purchaseDate"],
    ["purchaseDate before the launch rules", { purchaseDate: "1999-12-31" }, "purchaseDate"],
    ["missing price", { totalPriceCents: undefined }, "totalPriceCents"],
    ["zero price", { totalPriceCents: 0 }, "totalPriceCents"],
    ["negative price", { totalPriceCents: -5 }, "totalPriceCents"],
    ["fractional price", { totalPriceCents: 10.5 }, "totalPriceCents"],
    ["price over the 32-bit column", { totalPriceCents: 2_147_483_648 }, "totalPriceCents"],
    ["unknown category", { category: "toaster" }, "category"],
    ["unknown entity", { entity: "welld_xx" }, "entity"],
  ];
  for (const [name, patch, field] of cases) {
    it(`${name} -> 422 naming ${field}, zero rows`, async () => {
      const res = await post({ ...valid, ...patch });
      expect(res.status).toBe(422);
      expect((await problemOf(res)).field).toBe(field);
      expect(await db.asset.count()).toBe(0);
      expect(await db.assetEvent.count()).toBe(0);
    });
  }
});

describe("POST /assets: closed years (AC-1.7)", () => {
  it("a purchase date in a closed year -> 409 fiscal_year_closed, zero rows", async () => {
    await db.fiscalYear.create({
      data: {
        entity: "welld_ch",
        year: 2025,
        openingCents: 0,
        disposalsCents: 0,
        purchasesCents: 0,
        depreciationCents: 0,
        closingCents: 0,
        source: "closed",
        closedByUserId: "acc-1",
      },
    });
    const res = await post({ ...valid, purchaseDate: "2025-12-31" });
    expect(res.status).toBe(409);
    const body = await problemOf(res);
    expect(body.code).toBe("fiscal_year_closed");
    expect(body["year"]).toBe(2025);
    expect(await db.asset.count()).toBe(0);
    expect((await post({ ...valid, purchaseDate: "2026-01-01" })).status).toBe(201);
  });
});

describe("POST /assets: authorization", () => {
  it("entity outside the asset scope -> 403 and nothing stored", async () => {
    harness.setResolve(resolving([grant("asset", "manage", ENTITY)], "welld_ch"));
    const res = await post({ ...valid, entity: "welld_it" });
    expect(res.status).toBe(403);
    expect(await db.asset.count()).toBe(0);
  });

  it("an unconditioned grant may register in either entity", async () => {
    harness.setResolve(resolving([grant("asset", "manage")], null));
    expect((await post({ ...valid, entity: "welld_it" })).status).toBe(201);
  });

  it("a ledger:manage-only caller -> 403", async () => {
    harness.setResolve(resolving([grant("ledger", "manage")], "welld_ch"));
    expect((await post(valid)).status).toBe(403);
  });

  it("a caller with no capability -> 403; no token -> 401", async () => {
    harness.setResolve(resolving([], "welld_ch"));
    expect((await post(valid)).status).toBe(403);
    expect((await post(valid, null)).status).toBe(401);
  });

  it("a conditioned grant on a caller with no entity attribute registers nothing", async () => {
    harness.setResolve(resolving([grant("asset", "manage", ENTITY)], null));
    expect((await post(valid)).status).toBe(403);
  });
});
