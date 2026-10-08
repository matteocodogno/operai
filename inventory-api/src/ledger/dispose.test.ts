/**
 * Dispose (T18, specs/015-hardware-inventory; AC-7.1, AC-7.3..AC-7.6, AC-11.1).
 * Real routers + middleware over the harness, real Postgres.
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
const { disposeRouter } = await import("./dispose.routes");
const { assetEditRouter } = await import("../assets/edit.routes");
const { assetTransitionsRouter } = await import("../assets/transitions.routes");
const { assignmentsRouter } = await import("../assignments/assignments.routes");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { __resetIdentityCacheForTests } = await import("../lib/identities");
const { eventChanges } = await import("../history/record");

const app = new OpenAPIHono();
app.route("/", disposeRouter);
app.route("/", assetEditRouter);
app.route("/", assetTransitionsRouter);
app.route("/", assignmentsRouter);
app.onError((err, c) => handleProblemError(err, c.req.path) ?? c.json({ error: String(err) }, 500));

const ENTITY: ResolvedPermission["conditions"] = { attributes: [{ key: "entity", match: "user" }] };
const grant = (
  resource: string,
  action: string,
  conditions: ResolvedPermission["conditions"] = null,
): ResolvedPermission => ({ resource, action, conditions });
const resolving = (permissions: ResolvedPermission[], entity: string | null) => async () => ({
  sub: "u",
  epoch: 1,
  permissions,
  entity,
  jobTitle: null,
});
const ACCOUNTANT = [grant("ledger", "manage", ENTITY)];
const MANAGER = [grant("asset", "manage", ENTITY)];
const BOTH = [...ACCOUNTANT, ...MANAGER];

let token: string;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
function as(permissions: ResolvedPermission[], entity: string | null) {
  __resetAuthzCacheForTests();
  harness.setResolve(resolving(permissions, entity));
}

beforeAll(async () => {
  token = await harness.signToken({ sub: "acc-1", email: "acc1@welld.ch", permEpoch: 1 });
});
beforeEach(async () => {
  await truncateInventoryTables();
  __resetAuthzCacheForTests();
  __resetIdentityCacheForTests();
  as(ACCOUNTANT, "welld_ch");
  fetchSpy = spyOn(globalThis, "fetch");
  fetchSpy.mockImplementation((async (_url: unknown, init?: RequestInit) => {
    const ids = (JSON.parse(String(init?.body)) as { ids: string[] }).ids;
    return Response.json({ users: ids.map((id) => ({ id, status: "active", name: `Name of ${id}` })) });
  }) as unknown as typeof fetch);
});
afterAll(async () => {
  fetchSpy?.mockRestore();
  await truncateInventoryTables();
});

const send = (method: string, path: string, body?: unknown, bearer: string | null = token) =>
  app.request(path, {
    method,
    headers: {
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const dispose = (id: string, body: unknown) => send("POST", `/assets/${id}/dispose`, body);

type Json = Record<string, any>;
const json = async (res: Response) => (await res.json()) as Json;

let seq = 0;
async function seed(status: string, over: Record<string, unknown> = {}) {
  seq++;
  return db.asset.create({
    data: {
      entity: "welld_ch",
      currency: "CHF",
      category: "laptop",
      description: `Device ${seq}`,
      purchaseDate: new Date("2026-03-01"),
      purchasePriceCents: 99815,
      status,
      createdByUserId: "seed",
      ...over,
    } as never,
  });
}
const reload = (id: string) => db.asset.findUniqueOrThrow({ where: { id } });
const closeYear = (entity: "welld_ch" | "welld_it", year: number) =>
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

describe("disposing (AC-7.1)", () => {
  for (const status of ["ordered", "in_stock", "assigned", "in_repair", "lost"] as const) {
    it(`from ${status}: status disposed, holder cleared, one disposed event`, async () => {
      const holder = status === "assigned" || status === "in_repair" ? "emp-1" : null;
      const a = await seed(status, { holderUserId: holder });
      const res = await dispose(a.id, { disposedOn: "2026-06-30", reason: "scrapped" });
      expect(res.status).toBe(200);
      const v = await json(res);
      expect(v["status"]).toBe("disposed");
      expect(v["holder"]).toBeNull();
      expect(v["disposal"]).toEqual({ disposedOn: "2026-06-30", reason: "scrapped", salePriceCents: null });
      expect(v["ledger"].bookValueCents).toBe(0);
      const row = await reload(a.id);
      expect(row.holderUserId).toBeNull();
      expect(row.disposalReason).toBe("scrapped");

      const events = await db.assetEvent.findMany({ where: { assetId: a.id } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ action: "disposed", actorUserId: "acc-1" });
      const changes = eventChanges(events[0]!.oldValue, events[0]!.newValue);
      expect(changes).toContainEqual({ field: "status", from: status, to: "disposed" });
      expect(changes).toContainEqual({ field: "disposedOn", from: null, to: "2026-06-30" });
      expect(changes).toContainEqual({ field: "reason", from: null, to: "scrapped" });
      if (holder) expect(changes).toContainEqual({ field: "holder", from: holder, to: null });
    });
  }

  it("the serial number is free again afterwards (AC-1.5 partial index)", async () => {
    const a = await seed("in_stock", { serialNumber: "SN-1" });
    await dispose(a.id, { disposedOn: "2026-06-30", reason: "scrapped" });
    await seed("in_stock", { serialNumber: "SN-1" });
  });
});

describe("pending assignment (AC-7.5)", () => {
  it("409 assignment_pending naming the assignment; nothing changes", async () => {
    const a = await seed("in_stock");
    const p = await db.assignment.create({
      data: { assetId: a.id, assigneeUserId: "emp-1", createdByUserId: "mgr" },
    });
    const res = await dispose(a.id, { disposedOn: "2026-06-30", reason: "scrapped" });
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body["code"]).toBe("assignment_pending");
    expect(body["assignmentId"]).toBe(p.id);
    expect((await reload(a.id)).status).toBe("in_stock");
    expect(await db.assetEvent.count({ where: { assetId: a.id } })).toBe(0);
  });

  it("a cancelled assignment no longer blocks", async () => {
    const a = await seed("in_stock");
    await db.assignment.create({
      data: { assetId: a.id, assigneeUserId: "emp-1", createdByUserId: "mgr", status: "cancelled" },
    });
    expect((await dispose(a.id, { disposedOn: "2026-06-30", reason: "scrapped" })).status).toBe(200);
  });
});

describe("date rules (AC-7.4)", () => {
  it("a date in a closed year -> 409 fiscal_year_closed with the year", async () => {
    const a = await seed("in_stock", { purchaseDate: new Date("2024-02-01") });
    await closeYear("welld_ch", 2025);
    const res = await dispose(a.id, { disposedOn: "2025-12-31", reason: "scrapped" });
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body["code"]).toBe("fiscal_year_closed");
    expect(body["year"]).toBe(2025);
    expect((await reload(a.id)).status).toBe("in_stock");
  });

  it("the first date of the open year is accepted", async () => {
    const a = await seed("in_stock", { purchaseDate: new Date("2024-02-01") });
    await closeYear("welld_ch", 2025);
    expect((await dispose(a.id, { disposedOn: "2026-01-01", reason: "scrapped" })).status).toBe(200);
  });

  it("before the purchase date -> 422 disposed_before_purchase", async () => {
    const a = await seed("in_stock", { purchaseDate: new Date("2026-03-01") });
    const res = await dispose(a.id, { disposedOn: "2026-02-28", reason: "scrapped" });
    expect(res.status).toBe(422);
    expect((await json(res))["code"]).toBe("disposed_before_purchase");
  });

  it("on the purchase date is accepted", async () => {
    const a = await seed("in_stock", { purchaseDate: new Date("2026-03-01") });
    expect((await dispose(a.id, { disposedOn: "2026-03-01", reason: "scrapped" })).status).toBe(200);
  });

  it("a malformed date or unknown reason -> 422 naming the field", async () => {
    const a = await seed("in_stock");
    const bad = await dispose(a.id, { disposedOn: "2026-02-30", reason: "scrapped" });
    expect(bad.status).toBe(422);
    expect((await json(bad))["field"]).toBe("disposedOn");
    const reason = await dispose(a.id, { disposedOn: "2026-06-30", reason: "donated" });
    expect(reason.status).toBe(422);
    expect((await json(reason))["field"]).toBe("reason");
  });
});

describe("sale price (AC-7.3)", () => {
  for (const reason of ["sold", "ceded_to_employee"] as const) {
    it(`accepted for ${reason}, stored and returned`, async () => {
      const a = await seed("in_stock");
      const res = await dispose(a.id, { disposedOn: "2026-06-30", reason, salePriceCents: 12000 });
      expect(res.status).toBe(200);
      expect((await json(res))["disposal"]).toEqual({
        disposedOn: "2026-06-30",
        reason,
        salePriceCents: 12000,
      });
      const e = await db.assetEvent.findFirstOrThrow({ where: { assetId: a.id } });
      expect(eventChanges(e.oldValue, e.newValue)).toContainEqual({
        field: "salePriceCents",
        from: null,
        to: 12000,
      });
    });
  }

  for (const reason of ["scrapped", "returned_to_vendor", "lost"] as const) {
    it(`not allowed for ${reason} -> 422 sale_price_not_allowed, nothing written`, async () => {
      const a = await seed("in_stock");
      const res = await dispose(a.id, { disposedOn: "2026-06-30", reason, salePriceCents: 100 });
      expect(res.status).toBe(422);
      expect((await json(res))["code"]).toBe("sale_price_not_allowed");
      expect((await reload(a.id)).status).toBe("in_stock");
    });
  }

  it("a negative price is a validation error", async () => {
    const a = await seed("in_stock");
    const res = await dispose(a.id, { disposedOn: "2026-06-30", reason: "sold", salePriceCents: -1 });
    expect(res.status).toBe(422);
  });
});

describe("irreversible (AC-7.6)", () => {
  it("a second dispose -> 409 asset_disposed", async () => {
    const a = await seed("in_stock");
    await dispose(a.id, { disposedOn: "2026-06-30", reason: "scrapped" });
    const res = await dispose(a.id, { disposedOn: "2026-07-01", reason: "sold" });
    expect(res.status).toBe(409);
    expect((await json(res))["code"]).toBe("asset_disposed");
    expect((await reload(a.id)).disposalReason).toBe("scrapped");
  });

  it("every route of T13, T14 and T15 on the asset -> 409 asset_disposed; the status never changes", async () => {
    as(BOTH, "welld_ch");
    const a = await seed("in_stock");
    await dispose(a.id, { disposedOn: "2026-06-30", reason: "scrapped" });

    const calls: [string, string, unknown?][] = [
      ["PATCH", `/assets/${a.id}`, { description: "x" }],
      ...(["receive", "return", "repair", "repair-done", "lost", "found"] as const).map(
        (r) => ["POST", `/assets/${a.id}/${r}`] as [string, string],
      ),
      ["POST", `/assets/${a.id}/assignments`, { assigneeUserId: "emp-1" }],
    ];
    for (const [method, path, body] of calls) {
      const res = await send(method, path, body);
      expect(res.status).toBe(409);
      expect((await json(res))["code"]).toBe("asset_disposed");
    }
    expect((await reload(a.id)).status).toBe("disposed");
  });
});

describe("authorization", () => {
  it("asset:manage-only -> 403, nothing changes", async () => {
    as(MANAGER, "welld_ch");
    const a = await seed("in_stock");
    const res = await dispose(a.id, { disposedOn: "2026-06-30", reason: "scrapped" });
    expect(res.status).toBe(403);
    expect((await reload(a.id)).status).toBe("in_stock");
  });

  it("the other entity's asset, or an unknown id -> 404", async () => {
    const it = await seed("in_stock", { entity: "welld_it", currency: "EUR" });
    expect((await dispose(it.id, { disposedOn: "2026-06-30", reason: "scrapped" })).status).toBe(404);
    expect((await dispose("nope", { disposedOn: "2026-06-30", reason: "scrapped" })).status).toBe(404);
  });

  it("no token -> 401", async () => {
    const a = await seed("in_stock");
    const res = await send("POST", `/assets/${a.id}/dispose`, { disposedOn: "2026-06-30", reason: "scrapped" }, null);
    expect(res.status).toBe(401);
  });
});

describe("concurrency", () => {
  it("two disposes at once: exactly one 200, one event", async () => {
    const a = await seed("in_stock");
    const results = await Promise.all([
      dispose(a.id, { disposedOn: "2026-06-30", reason: "scrapped" }),
      dispose(a.id, { disposedOn: "2026-06-30", reason: "sold" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await db.assetEvent.count({ where: { assetId: a.id, action: "disposed" } })).toBe(1);
  }, 20_000);

  it("dispose racing a return: exactly one wins and the asset ends consistent", async () => {
    const a = await seed("assigned", { holderUserId: "emp-1" });
    as(BOTH, "welld_ch");
    const [d, r] = await Promise.all([
      dispose(a.id, { disposedOn: "2026-06-30", reason: "scrapped" }),
      send("POST", `/assets/${a.id}/return`),
    ]);
    const row = await reload(a.id);
    // Either dispose first (return then refused) or return first (dispose then applies).
    expect(d.status).toBe(200);
    expect(row.status).toBe("disposed");
    expect(row.holderUserId).toBeNull();
    expect([200, 409]).toContain(r.status);
    if (r.status === 409) expect((await json(r))["code"]).toBe("asset_disposed");
  }, 20_000);
});
