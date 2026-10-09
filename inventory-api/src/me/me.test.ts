/**
 * `/me/*` (T16, specs/015-hardware-inventory; AC-2.3, AC-2.4, AC-2.6, AC-2.7,
 * AC-4.1, AC-4.2, AC-4.4; ADR-0045). JWT only: the harness's authz fixture is
 * made to FAIL for the whole file, so every test also proves these routes do
 * not depend on `auth /authz/resolve`.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, spyOn, setSystemTime } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { setupTestAuth } from "../test-support/testAuth";
import { truncateInventoryTables } from "../test-support/dbCleanup";

const harness = setupTestAuth();
await harness.init();

const { db } = await import("../lib/db");
const { handleProblemError } = await import("../lib/problem");
const { meRouter } = await import("./me.routes");
const { assignmentHooks } = await import("../assignments/assignments.routes");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { eventChanges } = await import("../history/record");

const app = new OpenAPIHono();
app.route("/", meRouter);
app.onError((err, c) => handleProblemError(err, c.req.path) ?? c.json({ error: String(err) }, 500));

let emp: string;
let other: string;
let calls0 = 0;

beforeAll(async () => {
  emp = await harness.signToken({ sub: "emp-1", email: "emp1@welld.ch", permEpoch: 1 });
  other = await harness.signToken({ sub: "emp-2", email: "emp2@welld.ch", permEpoch: 1 });
});
beforeEach(async () => {
  await truncateInventoryTables();
  __resetAuthzCacheForTests();
  harness.setResolve(async () => {
    throw new Error("auth /authz/resolve must not be called by /me/*");
  });
  calls0 = harness.resolveCallCount();
});
afterEach(() => setSystemTime());
afterAll(async () => {
  await truncateInventoryTables();
});

const req = (method: string, path: string, bearer: string | null = emp) =>
  app.request(path, { method, headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} });
const devices = (bearer: string | null = emp) => req("GET", "/me/devices", bearer);
const confirm = (id: string, bearer: string | null = emp) => req("POST", `/me/assignments/${id}/confirm`, bearer);
const decline = (id: string, bearer: string | null = emp) => req("POST", `/me/assignments/${id}/decline`, bearer);
const problemOf = async (res: Response) => (await res.json()) as Record<string, unknown>;

let seq = 0;
async function seed(status = "in_stock", over: Record<string, unknown> = {}) {
  seq++;
  return db.asset.create({
    data: {
      entity: "welld_ch",
      currency: "CHF",
      category: "laptop",
      description: `Device ${seq}`,
      serialNumber: `SN-${seq}`,
      purchaseDate: new Date("2026-03-01"),
      purchasePriceCents: 99815,
      status,
      createdByUserId: "seed",
      ...over,
    } as never,
  });
}
const pend = (assetId: string, assignee = "emp-1", over: Record<string, unknown> = {}) =>
  db.assignment.create({ data: { assetId, assigneeUserId: assignee, createdByUserId: "mgr-1", ...over } as never });
const reload = (id: string) => db.asset.findUniqueOrThrow({ where: { id } });
const eventsOf = (assetId: string) =>
  db.assetEvent.findMany({ where: { assetId }, orderBy: { createdAt: "asc" } });

/** Every key of every object in a JSON value. */
const keysOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap(keysOf)
    : value && typeof value === "object"
      ? Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)])
      : [];

describe("GET /me/devices (AC-4.1, AC-4.4)", () => {
  it("a user with no grants and nothing assigned gets the empty shape", async () => {
    await seed("assigned", { holderUserId: "emp-2" });
    const res = await devices();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ devices: [], pending: [] });
  });

  it("lists the devices held and the assignments waiting, each with the five fields", async () => {
    const held = await seed("assigned", { holderUserId: "emp-1" });
    const repairing = await seed("in_repair", { holderUserId: "emp-1" });
    const offered = await seed("in_stock");
    const p = await pend(offered.id);
    const confirmedAt = new Date("2026-05-02T10:00:00Z");
    await pend(held.id, "emp-1", { status: "confirmed", resolvedAt: confirmedAt });
    const body = (await (await devices()).json()) as {
      devices: Record<string, unknown>[];
      pending: Record<string, unknown>[];
    };
    expect(body.devices.map((d) => d["assetId"]).sort()).toEqual([held.id, repairing.id].sort());
    const h = body.devices.find((d) => d["assetId"] === held.id)!;
    expect(h).toEqual({
      assetId: held.id,
      description: held.description,
      category: "laptop",
      serialNumber: held.serialNumber,
      assignedAt: confirmedAt.toISOString(),
    });
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0]).toEqual({
      assignmentId: p.id,
      assetId: offered.id,
      description: offered.description,
      category: "laptop",
      serialNumber: offered.serialNumber,
      assignedAt: p.createdAt.toISOString(),
    });
  });

  it("never shows someone else's device or offer, nor a resolved offer, nor a lost or disposed asset", async () => {
    const theirs = await seed("assigned", { holderUserId: "emp-2" });
    await pend((await seed("in_stock")).id, "emp-2");
    for (const status of ["declined", "cancelled", "confirmed"]) {
      await pend((await seed("in_stock")).id, "emp-1", { status, resolvedAt: new Date() });
    }
    await seed("lost");
    void theirs;
    expect(await (await devices()).json()).toEqual({ devices: [], pending: [] });
  });

  it("carries no price, cents, ledger or schedule key anywhere (AC-4.2)", async () => {
    const a = await seed("assigned", { holderUserId: "emp-1" });
    await pend((await seed("in_stock")).id);
    await pend(a.id, "emp-1", { status: "confirmed", resolvedAt: new Date() });
    const json = await (await devices()).json();
    const keys = keysOf(json);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((k) => /price|cents|ledger|schedule/i.test(k))).toEqual([]);
    expect(keys).not.toContain("entity");
    expect(keys).not.toContain("currency");
  });

  it("works with no grants and with auth /authz/resolve down", async () => {
    await seed("assigned", { holderUserId: "emp-1" });
    expect((await devices()).status).toBe(200);
    expect(harness.resolveCallCount()).toBe(calls0);
  });

  it("requires a token", async () => {
    expect((await devices(null)).status).toBe(401);
  });
});

describe("a pending assignment never expires (AC-2.6)", () => {
  it("is still pending, unchanged in the database, 30 days on", async () => {
    const a = await seed("in_stock");
    const p = await pend(a.id, "emp-1", { createdAt: new Date(Date.now() - 31 * 86_400_000) });
    setSystemTime(new Date(Date.now() + 30 * 86_400_000));
    // The 1h token would have expired by then; a clock jump needs a fresh one.
    const later = await harness.signToken({ sub: "emp-1", email: "emp1@welld.ch", permEpoch: 1 });
    const body = (await (await devices(later)).json()) as { pending: { assignmentId: string }[] };
    expect(body.pending.map((x) => x.assignmentId)).toEqual([p.id]);
    setSystemTime();
    expect(await db.assignment.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({
      status: "pending",
      resolvedAt: null,
    });
    expect((await reload(a.id)).status).toBe("in_stock");
  });
});

describe("POST /me/assignments/{id}/confirm (AC-2.3)", () => {
  it("confirms: assignment confirmed, asset assigned, the caller is the holder", async () => {
    const a = await seed("in_stock");
    const p = await pend(a.id);
    const res = await confirm(p.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { device: Record<string, unknown> };
    expect(Object.keys(body)).toEqual(["device"]);
    expect(body.device).toMatchObject({ assetId: a.id, description: a.description, category: "laptop" });
    expect(keysOf(body).filter((k) => /price|cents|ledger|schedule/i.test(k))).toEqual([]);
    const row = await reload(a.id);
    expect([row.status, row.holderUserId]).toEqual(["assigned", "emp-1"]);
    const after = await db.assignment.findUniqueOrThrow({ where: { id: p.id } });
    expect(after).toMatchObject({ status: "confirmed", resolvedByUserId: "emp-1" });
    expect(after.resolvedAt).toBeInstanceOf(Date);
    expect(body.device["assignedAt"]).toBe(after.resolvedAt!.toISOString());
    // and it now shows as held
    const list = (await (await devices()).json()) as { devices: unknown[]; pending: unknown[] };
    expect([list.devices.length, list.pending.length]).toEqual([1, 0]);
  });

  it("records `assignment_confirmed` with status and holder changes, actor = the employee", async () => {
    const a = await seed("in_stock");
    const p = await pend(a.id);
    await confirm(p.id);
    const [e] = await eventsOf(a.id);
    expect(e).toMatchObject({ action: "assignment_confirmed", actorUserId: "emp-1", actorEmail: "emp1@welld.ch" });
    expect(eventChanges(e!.oldValue, e!.newValue)).toEqual([
      { field: "holder", from: null, to: "emp-1" },
      { field: "status", from: "in_stock", to: "assigned" },
    ]);
  });
});

describe("POST /me/assignments/{id}/decline (AC-2.4)", () => {
  it("declines: 204, assignment declined, asset stays in_stock with no holder, assignable again", async () => {
    const a = await seed("in_stock");
    const p = await pend(a.id);
    const res = await decline(p.id);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(await db.assignment.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({
      status: "declined",
      resolvedByUserId: "emp-1",
    });
    const row = await reload(a.id);
    expect([row.status, row.holderUserId]).toEqual(["in_stock", null]);
    // the partial unique index no longer blocks a new offer
    expect((await pend(a.id, "emp-3")).status).toBe("pending");
    const e = (await eventsOf(a.id))[0]!;
    expect(e).toMatchObject({ action: "assignment_declined", actorUserId: "emp-1" });
    expect(eventChanges(e.oldValue, e.newValue)).toEqual([{ field: "assignee", from: "emp-1", to: null }]);
  });
});

describe("who may answer (AC-2.7)", () => {
  it("another user, and an unknown id, get the same 404 and change nothing", async () => {
    const a = await seed("in_stock");
    const p = await pend(a.id);
    const results = [
      await confirm(p.id, other),
      await decline(p.id, other),
      await confirm("nope", other),
      await decline("nope"),
    ];
    for (const r of results) expect(r.status).toBe(404);
    const bodies = await Promise.all(results.map(async (r) => (await problemOf(r))["detail"]));
    expect(new Set(bodies).size).toBe(1);
    expect(await db.assignment.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ status: "pending" });
    expect((await reload(a.id)).status).toBe("in_stock");
    expect(await eventsOf(a.id)).toHaveLength(0);
  });

  it("a manager is not the assignee either: only the assignee may confirm", async () => {
    const a = await seed("in_stock");
    const p = await pend(a.id, "emp-2"); // created by mgr-1
    const mgr = await harness.signToken({ sub: "mgr-1", email: "m@welld.ch", permEpoch: 1 });
    expect((await confirm(p.id, mgr)).status).toBe(404);
  });

  it("requires a token", async () => {
    const p = await pend((await seed("in_stock")).id);
    expect((await confirm(p.id, null)).status).toBe(401);
    expect((await decline(p.id, null)).status).toBe(401);
  });
});

describe("a resolved assignment is 409 assignment_not_pending", () => {
  it("for confirm and decline, and nothing changes", async () => {
    for (const status of ["confirmed", "declined", "cancelled"]) {
      const a = await seed("in_stock");
      const p = await pend(a.id, "emp-1", { status, resolvedAt: new Date() });
      for (const act of [confirm, decline]) {
        const res = await act(p.id);
        expect(res.status).toBe(409);
        expect((await problemOf(res))["code"]).toBe("assignment_not_pending");
      }
      expect(await db.assignment.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ status });
      expect((await reload(a.id)).holderUserId).toBeNull();
    }
  });

  it("concurrent answers: exactly one wins", async () => {
    for (const pair of [
      (id: string) => [confirm(id), confirm(id)],
      (id: string) => [confirm(id), decline(id)],
      (id: string) => [decline(id), decline(id)],
    ]) {
      const a = await seed("in_stock");
      const p = await pend(a.id);
      const results = await Promise.all(pair(p.id));
      const ok = results.filter((r) => r.status === 200 || r.status === 204);
      const lost = results.filter((r) => r.status === 409);
      expect([ok.length, lost.length]).toEqual([1, 1]);
      expect(await eventsOf(a.id)).toHaveLength(1);
      const row = await reload(a.id);
      const asg = await db.assignment.findUniqueOrThrow({ where: { id: p.id } });
      expect(row.holderUserId).toBe(asg.status === "confirmed" ? "emp-1" : null);
    }
  });
});

describe("the after-commit hook (T17 seam)", () => {
  it("confirm and decline report the outcome to the creating manager, after commit", async () => {
    const seen: any[] = [];
    const spy = spyOn(assignmentHooks, "afterCommit").mockImplementation(async (event) => {
      const row = await db.assignment.findUnique({ where: { id: event.assignmentId } });
      seen.push({ event, committed: row?.status });
    });
    try {
      const a = await seed("in_stock");
      const p = await pend(a.id);
      await confirm(p.id);
      const b = await seed("in_stock");
      const q = await pend(b.id);
      await decline(q.id);
      // a refused answer reports nothing
      await confirm(p.id);
      await confirm(p.id, other);
    } finally {
      spy.mockRestore();
    }
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      committed: "confirmed",
      event: { kind: "confirmed", assigneeUserId: "emp-1", createdByUserId: "mgr-1" },
    });
    expect(seen[1]).toMatchObject({ committed: "declined", event: { kind: "declined" } });
  });

  it("a throwing hook does not fail or undo the answer", async () => {
    const spy = spyOn(assignmentHooks, "afterCommit").mockImplementation(() => {
      throw new Error("boom");
    });
    try {
      const p = await pend((await seed("in_stock")).id);
      expect((await confirm(p.id)).status).toBe(200);
      expect((await db.assignment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("confirmed");
    } finally {
      spy.mockRestore();
    }
  });
});
