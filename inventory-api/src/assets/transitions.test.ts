/**
 * Status transitions (T14, specs/015-hardware-inventory; AC-1.8, AC-3.1..3.5,
 * AC-11.1). Real router + middleware over the harness, real Postgres.
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
const { assetTransitionsRouter } = await import("./transitions.routes");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { __resetIdentityCacheForTests } = await import("../lib/identities");
const { eventChanges } = await import("../history/record");

const app = new OpenAPIHono();
app.route("/", assetTransitionsRouter);
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
const BOTH = [...MANAGER, grant("ledger", "manage", ENTITY)];

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

const post = (id: string, route: string, bearer: string | null = token) =>
  app.request(`/assets/${id}/${route}`, {
    method: "POST",
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });

type View = Record<string, any> & { id: string };
const viewOf = async (res: Response) => (await res.json()) as View;
const problemOf = async (res: Response) => (await res.json()) as Record<string, unknown>;

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
const eventsOf = (assetId: string) =>
  db.assetEvent.findMany({ where: { assetId }, orderBy: { createdAt: "asc" } });
const pend = (assetId: string, assignee = "emp-1") =>
  db.assignment.create({ data: { assetId, assigneeUserId: assignee, createdByUserId: "mgr-1" } });

const ROUTES = ["receive", "return", "repair", "repair-done", "lost", "found"] as const;

describe("allowed transitions", () => {
  it("receive: ordered -> in_stock (AC-1.8), one `received` event", async () => {
    const a = await seed("ordered");
    const res = await post(a.id, "receive");
    expect(res.status).toBe(200);
    expect((await viewOf(res))["status"]).toBe("in_stock");
    const [e] = await eventsOf(a.id);
    expect(e).toMatchObject({ action: "received", actorUserId: "mgr-1", actorEmail: "mgr1@welld.ch" });
    expect(eventChanges(e!.oldValue, e!.newValue)).toEqual([
      { field: "status", from: "ordered", to: "in_stock" },
    ]);
  });

  it("return: assigned -> in_stock and the holder is cleared (AC-3.1)", async () => {
    const a = await seed("assigned", { holderUserId: "emp-1" });
    const v = await viewOf(await post(a.id, "return"));
    expect(v["status"]).toBe("in_stock");
    expect(v["holder"]).toBeNull();
    expect((await reload(a.id)).holderUserId).toBeNull();
    const [e] = await eventsOf(a.id);
    expect(e?.action).toBe("returned");
    expect(eventChanges(e!.oldValue, e!.newValue)).toEqual([
      { field: "holder", from: "emp-1", to: null },
      { field: "status", from: "assigned", to: "in_stock" },
    ]);
  });

  it("repair: in_stock and assigned -> in_repair, holder unchanged (AC-3.2)", async () => {
    const free = await seed("in_stock");
    const held = await seed("assigned", { holderUserId: "emp-1" });
    expect((await viewOf(await post(free.id, "repair")))["status"]).toBe("in_repair");
    const v = await viewOf(await post(held.id, "repair"));
    expect(v["status"]).toBe("in_repair");
    expect(v["holder"]).toMatchObject({ id: "emp-1" });
    expect((await eventsOf(held.id))[0]?.action).toBe("repair_started");
  });

  it("repair-done: lands on assigned with a holder, in_stock without (AC-3.3)", async () => {
    const held = await seed("in_repair", { holderUserId: "emp-1" });
    const free = await seed("in_repair");
    const v = await viewOf(await post(held.id, "repair-done"));
    expect(v["status"]).toBe("assigned");
    expect(v["holder"]).toMatchObject({ id: "emp-1" });
    expect((await viewOf(await post(free.id, "repair-done")))["status"]).toBe("in_stock");
    expect((await eventsOf(free.id))[0]?.action).toBe("repair_finished");
  });

  it("lost: from in_stock, assigned and in_repair; clears the holder; ledger unchanged (AC-3.4)", async () => {
    as(BOTH, "welld_ch");
    for (const [status, holder] of [
      ["in_stock", null],
      ["assigned", "emp-1"],
      ["in_repair", "emp-1"],
    ] as const) {
      const a = await seed(status, { holderUserId: holder });
      const res = await post(a.id, "lost");
      expect(res.status).toBe(200);
      const v = await viewOf(res);
      expect(v["status"]).toBe("lost");
      expect(v["holder"]).toBeNull();
      expect((await reload(a.id)).holderUserId).toBeNull();
      expect((await eventsOf(a.id))[0]?.action).toBe("marked_lost");
    }
  });

  it("lost leaves price, date and the schedule exactly as they were", async () => {
    as(BOTH, "welld_ch");
    const a = await seed("assigned", { holderUserId: "emp-1" });
    const row0 = await reload(a.id);
    const v = await viewOf(await post(a.id, "lost"));
    const row1 = await reload(a.id);
    expect([row1.purchasePriceCents, row1.purchaseDate, row1.disposedOn]).toEqual([
      row0.purchasePriceCents,
      row0.purchaseDate,
      null,
    ]);
    expect(v["ledger"].schedule.map((s: any) => s.depreciationCents)).toEqual([33238, 33238, 33239]);
  });

  it("found: lost -> in_stock (AC-3.5)", async () => {
    const a = await seed("lost");
    expect((await viewOf(await post(a.id, "found")))["status"]).toBe("in_stock");
    expect((await eventsOf(a.id))[0]?.action).toBe("marked_found");
  });
});

describe("disallowed source status -> 409 invalid_transition with `from`", () => {
  const BAD: Record<(typeof ROUTES)[number], string[]> = {
    receive: ["in_stock", "assigned", "in_repair", "lost"],
    return: ["ordered", "in_stock", "in_repair", "lost"],
    repair: ["ordered", "in_repair", "lost"],
    "repair-done": ["ordered", "in_stock", "assigned", "lost"],
    lost: ["ordered", "lost"],
    found: ["ordered", "in_stock", "assigned", "in_repair"],
  };
  for (const route of ROUTES) {
    it(`${route}`, async () => {
      for (const status of BAD[route]) {
        const a = await seed(status, status === "assigned" ? { holderUserId: "emp-1" } : {});
        const res = await post(a.id, route);
        expect(res.status).toBe(409);
        expect(await problemOf(res)).toMatchObject({ code: "invalid_transition", from: status });
        expect((await reload(a.id)).status).toBe(status as never);
        expect(await eventsOf(a.id)).toHaveLength(0);
      }
    });
  }
});

describe("a disposed asset accepts nothing", () => {
  it("every route is 409 asset_disposed", async () => {
    const a = await seed("disposed", { disposedOn: new Date("2026-06-01"), disposalReason: "scrapped" });
    for (const route of ROUTES) {
      const res = await post(a.id, route);
      expect(res.status).toBe(409);
      expect(await problemOf(res)).toMatchObject({ code: "asset_disposed", assetId: a.id });
    }
    expect((await reload(a.id)).status).toBe("disposed");
  });
});

describe("a pending assignment blocks repair and lost", () => {
  it("409 assignment_pending naming the assignment, nothing changes", async () => {
    const a = await seed("in_stock");
    const p = await pend(a.id);
    for (const route of ["repair", "lost"]) {
      const res = await post(a.id, route);
      expect(res.status).toBe(409);
      expect(await problemOf(res)).toMatchObject({ code: "assignment_pending", assignmentId: p.id });
    }
    expect((await reload(a.id)).status).toBe("in_stock");
    expect(await eventsOf(a.id)).toHaveLength(0);
  });

  it("a resolved assignment does not block", async () => {
    const a = await seed("in_stock");
    await db.assignment.create({
      data: { assetId: a.id, assigneeUserId: "e", createdByUserId: "m", status: "declined", resolvedAt: new Date() },
    });
    expect((await post(a.id, "repair")).status).toBe(200);
  });
});

describe("concurrency: compare-and-set on status", () => {
  const CASES: [(typeof ROUTES)[number], string, Record<string, unknown>][] = [
    ["receive", "ordered", {}],
    ["return", "assigned", { holderUserId: "emp-1" }],
    ["repair", "in_stock", {}],
    ["repair-done", "in_repair", {}],
    ["lost", "in_stock", {}],
    ["found", "lost", {}],
  ];
  for (const [route, status, over] of CASES) {
    it(`two ${route} calls: exactly one 200, the other 409, one event`, async () => {
      const a = await seed(status, over);
      const results = await Promise.all([post(a.id, route), post(a.id, route)]);
      const codes = results.map((r) => r.status).sort();
      expect(codes).toEqual([200, 409]);
      const loser = results.find((r) => r.status === 409)!;
      expect((await problemOf(loser))["code"]).toBe("invalid_transition");
      expect(await eventsOf(a.id)).toHaveLength(1);
    });
  }

  it("repair racing lost on one in_stock asset ends in a state both orders allow, with an event each", async () => {
    const a = await seed("in_stock");
    const results = await Promise.all([post(a.id, "repair"), post(a.id, "lost")]);
    // repair->lost is legal, lost->repair is not: either both win, or lost wins alone.
    const statuses = results.map((r) => r.status).sort();
    expect([[200, 200], [200, 409]]).toContainEqual(statuses);
    expect((await reload(a.id)).status).toBe("lost");
    expect((await eventsOf(a.id)).length).toBe(statuses.filter((s) => s === 200).length);
  });
});

describe("capability and scope", () => {
  it("an accountant-only caller is 403 on every route", async () => {
    as([grant("ledger", "manage", ENTITY)], "welld_ch");
    const a = await seed("ordered");
    for (const route of ROUTES) expect((await post(a.id, route)).status).toBe(403);
    expect((await reload(a.id)).status).toBe("ordered");
  });

  it("an asset of another entity, and an unknown id, are 404", async () => {
    const other = await seed("ordered", { entity: "welld_it", currency: "EUR" });
    expect((await post(other.id, "receive")).status).toBe(404);
    expect((await post("nope", "receive")).status).toBe(404);
    expect((await reload(other.id)).status).toBe("ordered");
  });

  it("requires a token", async () => {
    const a = await seed("ordered");
    expect((await post(a.id, "receive", null)).status).toBe(401);
  });
});
