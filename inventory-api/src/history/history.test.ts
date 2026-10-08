/**
 * `GET /assets/{id}/history` (T22, specs/015-hardware-inventory; AC-11.3,
 * AC-11.4, AC-9.2, AC-9.4, AC-4.3). Real routers over the harness, real Postgres.
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
const { historyRouter } = await import("./history.routes");
const { assignmentsRouter } = await import("../assignments/assignments.routes");
const { meRouter } = await import("../me/me.routes");
const { assetTransitionsRouter } = await import("../assets/transitions.routes");
const { assetEditRouter } = await import("../assets/edit.routes");
const { disposeRouter } = await import("../ledger/dispose.routes");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { __resetIdentityCacheForTests } = await import("../lib/identities");

const app = new OpenAPIHono();
app.route("/", historyRouter);
app.route("/", assignmentsRouter);
app.route("/", meRouter);
app.route("/", assetTransitionsRouter);
app.route("/", assetEditRouter);
app.route("/", disposeRouter);
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
const MANAGER = [grant("asset", "manage", ENTITY)];
const ACCOUNTANT = [grant("ledger", "manage", ENTITY)];
const BOTH = [...MANAGER, ...ACCOUNTANT];

const tokens: Record<string, string> = {};
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let identityCalls: string[][] = [];
let deletedIds = new Set<string>();
function as(permissions: ResolvedPermission[], entity: string | null) {
  __resetAuthzCacheForTests();
  harness.setResolve(resolving(permissions, entity));
}

beforeAll(async () => {
  for (const sub of ["mgr-1", "emp-1", "emp-2", "acc-1"]) {
    tokens[sub] = await harness.signToken({ sub, email: `${sub}@welld.ch`, permEpoch: 1 });
  }
});
beforeEach(async () => {
  await truncateInventoryTables();
  __resetAuthzCacheForTests();
  __resetIdentityCacheForTests();
  identityCalls = [];
  deletedIds = new Set();
  as(BOTH, "welld_ch");
  fetchSpy = spyOn(globalThis, "fetch");
  fetchSpy.mockImplementation((async (_url: unknown, init?: RequestInit) => {
    const ids = (JSON.parse(String(init?.body)) as { ids: string[] }).ids;
    identityCalls.push(ids);
    return Response.json({
      users: ids.map((id) =>
        deletedIds.has(id) ? { id, status: "deleted" } : { id, status: "active", name: `Name of ${id}` },
      ),
    });
  }) as unknown as typeof fetch);
});
afterAll(async () => {
  fetchSpy?.mockRestore();
  await truncateInventoryTables();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = (method: string, path: string, who = "mgr-1", body?: unknown) =>
  app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${tokens[who]}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const history = (id: string, who = "mgr-1") => call("GET", `/assets/${id}/history`, who);

type Json = Record<string, any>;
const json = async (res: Response) => (await res.json()) as Json;

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
const event = (assetId: string, over: Record<string, unknown>) =>
  db.assetEvent.create({
    data: {
      assetId,
      entity: "welld_ch",
      action: "edited",
      actorUserId: "mgr-1",
      actorEmail: "mgr-1@welld.ch",
      ...over,
    } as never,
  });

describe("order, actor and typed changes (AC-11.3)", () => {
  it("returns every event oldest first, whatever order they were inserted in", async () => {
    const a = await seed();
    await event(a.id, { action: "disposed", createdAt: new Date("2026-05-03T10:00:00Z") });
    await event(a.id, { action: "registered", createdAt: new Date("2026-05-01T10:00:00Z") });
    await event(a.id, { action: "edited", createdAt: new Date("2026-05-02T10:00:00Z") });
    const res = await history(a.id);
    expect(res.status).toBe(200);
    const { events } = await json(res);
    expect(events.map((e: Json) => e["action"])).toEqual(["registered", "edited", "disposed"]);
    expect(events[0]["at"]).toBe("2026-05-01T10:00:00.000Z");
  });

  it("an event written in the same instant as another keeps a stable order", async () => {
    const a = await seed();
    const at = new Date("2026-05-01T10:00:00Z");
    await event(a.id, { action: "registered", createdAt: at });
    await event(a.id, { action: "edited", createdAt: at });
    const first = (await json(await history(a.id)))["events"].map((e: Json) => e["id"]);
    const second = (await json(await history(a.id)))["events"].map((e: Json) => e["id"]);
    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
  });

  it("carries the actor as an Identity and typed {field, from, to} changes", async () => {
    const a = await seed();
    await event(a.id, {
      action: "edited",
      oldValue: { purchasePriceCents: 99815, supplier: null, toVerify: true },
      newValue: { purchasePriceCents: 120000, supplier: "Acme", toVerify: false },
    });
    const [e] = (await json(await history(a.id)))["events"];
    expect(e["actor"]).toEqual({ id: "mgr-1", name: "Name of mgr-1", status: "active" });
    expect(e["changes"]).toEqual([
      { field: "purchasePriceCents", from: 99815, to: 120000 },
      { field: "supplier", from: null, to: "Acme" },
      { field: "toVerify", from: true, to: false },
    ]);
    expect(Object.keys(e).sort()).toEqual(["action", "actor", "at", "changes", "id"]);
  });

  it("an event with no changes has an empty list; the asset's own history only", async () => {
    const a = await seed();
    const other = await seed();
    await event(a.id, { action: "registered" });
    await event(other.id, { action: "edited" });
    await event(null as unknown as string, { action: "fiscal_year_closed", assetId: null });
    const { events } = await json(await history(a.id));
    expect(events).toHaveLength(1);
    expect(events[0]["changes"]).toEqual([]);
  });

  it("a brand-new asset with no events has an empty history", async () => {
    const a = await seed();
    expect(await json(await history(a.id))).toEqual({ events: [] });
  });
});

describe("identities (ADR-0039)", () => {
  it("system actors are 'system' and never sent to auth; a deleted account stays marked deleted; auth down -> unknown", async () => {
    const a = await seed();
    await event(a.id, { action: "imported", actorUserId: "system:legacy-import", actorEmail: "system@x" });
    await event(a.id, { action: "edited", actorUserId: "gone-1", actorEmail: "g@x" });
    deletedIds.add("gone-1");
    let { events } = await json(await history(a.id));
    expect(events[0]["actor"]).toEqual({ id: "system:legacy-import", name: null, status: "system" });
    expect(events[1]["actor"]).toEqual({ id: "gone-1", name: null, status: "deleted" });
    expect(identityCalls.flat()).not.toContain("system:legacy-import");

    __resetIdentityCacheForTests();
    fetchSpy.mockImplementation((async () => new Response("down", { status: 503 })) as unknown as typeof fetch);
    const res = await history(a.id);
    expect(res.status).toBe(200);
    events = (await json(res))["events"];
    expect(events[1]["actor"]).toEqual({ id: "gone-1", name: null, status: "unknown" });
    expect(events[0]["actor"]["status"]).toBe("system");
  });

  it("user ids in `holder` and `assignee` changes come back as Identity objects, in from and to alike", async () => {
    const a = await seed();
    await event(a.id, { action: "assignment_created", oldValue: { assignee: null }, newValue: { assignee: "emp-1" } });
    await event(a.id, {
      action: "returned",
      oldValue: { holder: "emp-1", status: "assigned" },
      newValue: { holder: null, status: "in_stock" },
    });
    await event(a.id, {
      action: "edited",
      oldValue: { holder: "system:legacy-import" },
      newValue: { holder: "emp-2" },
    });
    const { events } = await json(await history(a.id));
    expect(events[0]["changes"]).toEqual([
      { field: "assignee", from: null, to: { id: "emp-1", name: "Name of emp-1", status: "active" } },
    ]);
    expect(events[1]["changes"]).toEqual([
      { field: "holder", from: { id: "emp-1", name: "Name of emp-1", status: "active" }, to: null },
      { field: "status", from: "assigned", to: "in_stock" },
    ]);
    expect(events[2]["changes"][0]).toEqual({
      field: "holder",
      from: { id: "system:legacy-import", name: null, status: "system" },
      to: { id: "emp-2", name: "Name of emp-2", status: "active" },
    });
  });

  it("other string fields that merely look like ids are left alone", async () => {
    const a = await seed();
    await event(a.id, { action: "edited", oldValue: { locationNote: "emp-1" }, newValue: { locationNote: "emp-2" } });
    const [e] = (await json(await history(a.id)))["events"];
    expect(e["changes"]).toEqual([{ field: "locationNote", from: "emp-1", to: "emp-2" }]);
  });
});

describe("holder periods can be derived from the response alone (AC-11.4)", () => {
  it("assign -> confirm -> return -> assign -> confirm -> dispose", async () => {
    const a = await seed();
    const assign = async (assignee: string) => {
      const res = await call("POST", `/assets/${a.id}/assignments`, "mgr-1", { assigneeUserId: assignee });
      expect(res.status).toBe(201);
      return (await json(res))["pendingAssignment"]["id"] as string;
    };

    const p1 = await assign("emp-1");
    await sleep(15);
    expect((await call("POST", `/me/assignments/${p1}/confirm`, "emp-1")).status).toBe(200);
    await sleep(15);
    expect((await call("POST", `/assets/${a.id}/return`, "mgr-1")).status).toBe(200);
    await sleep(15);
    const p2 = await assign("emp-2");
    await sleep(15);
    expect((await call("POST", `/me/assignments/${p2}/confirm`, "emp-2")).status).toBe(200);
    await sleep(15);
    expect((await call("POST", `/assets/${a.id}/dispose`, "mgr-1", { disposedOn: "2026-09-01", reason: "scrapped" })).status).toBe(200);

    const res = await history(a.id);
    const { events } = await json(res);
    expect(events.map((e: Json) => e["action"])).toEqual([
      "assignment_created",
      "assignment_confirmed",
      "returned",
      "assignment_created",
      "assignment_confirmed",
      "disposed",
    ]);

    // Derive the holder periods from the response and nothing else.
    const periods: { holder: string; start: string; end: string | null }[] = [];
    for (const e of events) {
      for (const ch of e["changes"] as Json[]) {
        if (ch["field"] !== "holder") continue;
        if (ch["to"]) periods.push({ holder: ch["to"]["id"], start: e["at"], end: null });
        if (ch["from"]) {
          const open = periods.find((p) => p.end === null && p.holder === ch["from"]["id"])!;
          open.end = e["at"];
        }
      }
    }
    expect(periods.map((p) => p.holder)).toEqual(["emp-1", "emp-2"]);
    expect(periods.every((p) => p.end !== null)).toBe(true);
    expect(periods[0]!.start < periods[0]!.end!).toBe(true);
    expect(periods[0]!.end! <= periods[1]!.start).toBe(true);
    expect(periods[1]!.start < periods[1]!.end!).toBe(true);
    // Names come through for the timeline.
    const confirmed = events[1]["changes"].find((c: Json) => c["field"] === "holder");
    expect(confirmed["to"]).toEqual({ id: "emp-1", name: "Name of emp-1", status: "active" });
  }, 30_000);
});

describe("who may read (AC-9.2, AC-9.3, AC-9.4, AC-4.3)", () => {
  const seedWithPriceEdit = async () => {
    const a = await seed();
    await event(a.id, {
      action: "edited",
      oldValue: { purchasePriceCents: 99815 },
      newValue: { purchasePriceCents: 120000 },
    });
    return a;
  };

  it("an inventory manager reads it, price edits included, with no ledger figure anywhere", async () => {
    const a = await seedWithPriceEdit();
    as(MANAGER, "welld_ch");
    const res = await history(a.id);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("purchasePriceCents");
    expect(text).not.toMatch(/ledger|bookValue|schedule|rollForward/i);
  });

  it("a hardware accountant reads the same history", async () => {
    const a = await seedWithPriceEdit();
    as(MANAGER, "welld_ch");
    const asManager = await (await history(a.id)).text();
    as(ACCOUNTANT, "welld_ch");
    const res = await history(a.id, "acc-1");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(asManager);
  });

  it("the disposal's own fields (date, reason, sale price) are in the history for both", async () => {
    const a = await seed();
    const d = await call("POST", `/assets/${a.id}/dispose`, "acc-1", { disposedOn: "2026-09-01", reason: "sold", salePriceCents: 5000 });
    expect(d.status).toBe(200);
    for (const perms of [MANAGER, ACCOUNTANT]) {
      as(perms, "welld_ch");
      const { events } = await json(await history(a.id));
      expect(events[0]["changes"]).toContainEqual({ field: "salePriceCents", from: null, to: 5000 });
      expect(events[0]["changes"]).toContainEqual({ field: "reason", from: null, to: "sold" });
    }
  });

  it("an asset of the other entity, an unknown id, and a caller with no capability are all the same 404", async () => {
    const it = await seed({ entity: "welld_it", currency: "EUR" });
    const own = await seed();
    await event(own.id, { action: "registered" });
    expect((await history(it.id)).status).toBe(404);
    expect((await history("nope")).status).toBe(404);
    as([], null);
    const res = await history(own.id, "emp-1");
    expect(res.status).toBe(404);
    expect(await json(res)).not.toHaveProperty("events");
  });

  it("an unconditioned grant covers both entities (AC-9.5)", async () => {
    const it = await seed({ entity: "welld_it", currency: "EUR" });
    as([grant("asset", "manage")], null);
    expect((await history(it.id)).status).toBe(200);
  });

  it("no token -> 401", async () => {
    const a = await seed();
    expect((await app.request(`/assets/${a.id}/history`)).status).toBe(401);
  });
});
