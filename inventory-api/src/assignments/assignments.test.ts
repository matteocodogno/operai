/**
 * Assignments, manager side (T15, specs/015-hardware-inventory; AC-2.1, AC-2.2,
 * AC-2.5, AC-2.10, AC-11.1). Real router + middleware over the harness, real
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
const { assignmentsRouter, assignmentHooks } = await import("./assignments.routes");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { __resetIdentityCacheForTests } = await import("../lib/identities");
const { eventChanges } = await import("../history/record");

const app = new OpenAPIHono();
app.route("/", assignmentsRouter);
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

/** Identity statuses the stubbed `auth` answers with; anything else is active. */
const STATUS: Record<string, string> = { gone: "deleted", ghost: "unknown" };

let token: string;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
function as(permissions: ResolvedPermission[], entity: string | null) {
  __resetAuthzCacheForTests();
  harness.setResolve(resolving(permissions, entity));
}
const stubAuth = () =>
  fetchSpy.mockImplementation((async (_url: unknown, init?: RequestInit) => {
    const ids = (JSON.parse(String(init?.body)) as { ids: string[] }).ids;
    return Response.json({
      users: ids
        .filter((id) => STATUS[id] !== "unknown")
        .map((id) => ({ id, status: STATUS[id] ?? "active", name: STATUS[id] ? null : `Name of ${id}` })),
    });
  }) as unknown as typeof fetch);

beforeAll(async () => {
  token = await harness.signToken({ sub: "mgr-1", email: "mgr1@welld.ch", permEpoch: 1 });
});
beforeEach(async () => {
  await truncateInventoryTables();
  __resetAuthzCacheForTests();
  __resetIdentityCacheForTests();
  as(MANAGER, "welld_ch");
  fetchSpy = spyOn(globalThis, "fetch");
  stubAuth();
});
afterAll(async () => {
  fetchSpy?.mockRestore();
  await truncateInventoryTables();
});

const call = (path: string, body?: unknown, bearer: string | null = token) =>
  app.request(path, {
    method: "POST",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const assign = (assetId: string, assigneeUserId: unknown) =>
  call(`/assets/${assetId}/assignments`, { assigneeUserId });
const cancel = (assignmentId: string) => call(`/assignments/${assignmentId}/cancel`);

type View = Record<string, any> & { id: string };
const viewOf = async (res: Response) => (await res.json()) as View;
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
      purchaseDate: new Date("2026-03-01"),
      purchasePriceCents: 99815,
      status,
      createdByUserId: "seed",
      ...over,
    } as never,
  });
}
const reload = (id: string) => db.asset.findUniqueOrThrow({ where: { id } });
const rowsOf = (assetId: string) =>
  db.assignment.findMany({ where: { assetId }, orderBy: { createdAt: "asc" } });
const eventsOf = (assetId: string) =>
  db.assetEvent.findMany({ where: { assetId }, orderBy: { createdAt: "asc" } });

describe("POST /assets/{id}/assignments (AC-2.1)", () => {
  it("creates a pending assignment and leaves the asset in_stock with no holder", async () => {
    const a = await seed();
    const res = await assign(a.id, "emp-1");
    expect(res.status).toBe(201);
    const v = await viewOf(res);
    expect(v["status"]).toBe("in_stock");
    expect(v["holder"]).toBeNull();
    expect(v["pendingAssignment"]).toMatchObject({
      assignee: { id: "emp-1", name: "Name of emp-1", status: "active" },
    });
    const [row] = await rowsOf(a.id);
    expect(row).toMatchObject({
      assigneeUserId: "emp-1",
      status: "pending",
      createdByUserId: "mgr-1",
      resolvedAt: null,
    });
    expect(v["pendingAssignment"].id).toBe(row!.id);
    const row2 = await reload(a.id);
    expect([row2.status, row2.holderUserId]).toEqual(["in_stock", null]);
  });

  it("records an `assignment_created` event naming the assignee", async () => {
    const a = await seed();
    await assign(a.id, "emp-1");
    const [e] = await eventsOf(a.id);
    expect(e).toMatchObject({ action: "assignment_created", actorUserId: "mgr-1" });
    expect(eventChanges(e!.oldValue, e!.newValue)).toEqual([{ field: "assignee", from: null, to: "emp-1" }]);
  });

  it("a manager can assign to themselves", async () => {
    const a = await seed();
    expect((await assign(a.id, "mgr-1")).status).toBe(201);
  });

  it("an asset that is not in_stock is refused with 409 invalid_transition and `from` (AC-2.10)", async () => {
    for (const status of ["ordered", "assigned", "in_repair", "lost"]) {
      const a = await seed(status, status === "assigned" || status === "in_repair" ? { holderUserId: "h" } : {});
      const res = await assign(a.id, "emp-1");
      expect(res.status).toBe(409);
      expect(await problemOf(res)).toMatchObject({ code: "invalid_transition", from: status });
      expect(await rowsOf(a.id)).toHaveLength(0);
      expect(await eventsOf(a.id)).toHaveLength(0);
    }
  });

  it("a disposed asset is 409 asset_disposed", async () => {
    const a = await seed("disposed", { disposedOn: new Date("2026-06-01"), disposalReason: "scrapped" });
    const res = await assign(a.id, "emp-1");
    expect(res.status).toBe(409);
    expect((await problemOf(res))["code"]).toBe("asset_disposed");
  });

  it("a second assignment is 409 assignment_pending naming the first, even for the same person (AC-2.2)", async () => {
    const a = await seed();
    await assign(a.id, "emp-1");
    const [first] = await rowsOf(a.id);
    for (const who of ["emp-2", "emp-1"]) {
      const res = await assign(a.id, who);
      expect(res.status).toBe(409);
      expect(await problemOf(res)).toMatchObject({ code: "assignment_pending", assignmentId: first!.id });
    }
    expect(await rowsOf(a.id)).toHaveLength(1);
    expect(await eventsOf(a.id)).toHaveLength(1);
  });

  it("two concurrent requests: exactly one pending row, one 201, one 409", async () => {
    const a = await seed();
    const results = await Promise.all([assign(a.id, "emp-1"), assign(a.id, "emp-2")]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect((await problemOf(loser))["code"]).toBe("assignment_pending");
    expect((await rowsOf(a.id)).filter((r) => r.status === "pending")).toHaveLength(1);
  });

  it("when a rival pending row commits between our check and our insert, the partial unique index maps to 409 assignment_pending", async () => {
    const a = await seed();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const hasInserted = new Promise<void>((r) => (inserted = r));
    let rivalId = "";
    const rival = db.$transaction(async (tx) => {
      const r = await tx.assignment.create({
        data: { assetId: a.id, assigneeUserId: "rival", createdByUserId: "other" },
      });
      rivalId = r.id;
      inserted();
      await held;
    });
    await hasInserted;
    const pending = assign(a.id, "emp-1");
    await Bun.sleep(200);
    release();
    await rival;
    const res = await pending;
    expect(res.status).toBe(409);
    expect(await problemOf(res)).toMatchObject({ code: "assignment_pending", assignmentId: rivalId });
    expect(await eventsOf(a.id)).toHaveLength(0);
  });

  it("the assignee must be an active user: deleted, unknown and a down auth are 422 unknown_user", async () => {
    const a = await seed();
    for (const who of ["gone", "ghost"]) {
      const res = await assign(a.id, who);
      expect(res.status).toBe(422);
      expect(await problemOf(res)).toMatchObject({ code: "unknown_user", field: "assigneeUserId" });
    }
    __resetIdentityCacheForTests();
    fetchSpy.mockImplementation((async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch);
    expect((await assign(a.id, "emp-9")).status).toBe(422);
    expect(await rowsOf(a.id)).toHaveLength(0);
  });

  it("validates the body", async () => {
    const a = await seed();
    for (const body of [undefined, {}, { assigneeUserId: "" }, { assigneeUserId: 5 }]) {
      const res = await call(`/assets/${a.id}/assignments`, body ?? {});
      expect(res.status).toBe(422);
    }
  });

  it("is asset:manage only: accountant 403, other entity and unknown id 404, no token 401", async () => {
    const a = await seed();
    const other = await seed("in_stock", { entity: "welld_it", currency: "EUR" });
    expect((await assign(other.id, "emp-1")).status).toBe(404);
    expect((await assign("nope", "emp-1")).status).toBe(404);
    as([grant("ledger", "manage", ENTITY)], "welld_ch");
    expect((await assign(a.id, "emp-1")).status).toBe(403);
    expect((await call(`/assets/${a.id}/assignments`, { assigneeUserId: "x" }, null)).status).toBe(401);
    expect(await rowsOf(a.id)).toHaveLength(0);
  });
});

describe("POST /assignments/{id}/cancel (AC-2.5)", () => {
  it("cancels: row cancelled, asset in_stock with no holder, assignable again", async () => {
    const a = await seed();
    await assign(a.id, "emp-1");
    const [p] = await rowsOf(a.id);
    const res = await cancel(p!.id);
    expect(res.status).toBe(200);
    const v = await viewOf(res);
    expect(v["status"]).toBe("in_stock");
    expect(v["holder"]).toBeNull();
    expect(v["pendingAssignment"]).toBeNull();
    const after = await db.assignment.findUniqueOrThrow({ where: { id: p!.id } });
    expect(after).toMatchObject({ status: "cancelled", resolvedByUserId: "mgr-1" });
    expect(after.resolvedAt).toBeInstanceOf(Date);
    expect((await assign(a.id, "emp-2")).status).toBe(201);
  });

  it("records `assignment_cancelled`", async () => {
    const a = await seed();
    await assign(a.id, "emp-1");
    const [p] = await rowsOf(a.id);
    await cancel(p!.id);
    const e = (await eventsOf(a.id)).find((x) => x.action === "assignment_cancelled")!;
    expect(e.actorUserId).toBe("mgr-1");
    expect(eventChanges(e.oldValue, e.newValue)).toEqual([{ field: "assignee", from: "emp-1", to: null }]);
  });

  it("a non-pending assignment is 409 assignment_not_pending and stays as it was", async () => {
    const a = await seed("assigned", { holderUserId: "emp-1" });
    for (const status of ["confirmed", "declined", "cancelled"]) {
      const p = await db.assignment.create({
        data: { assetId: a.id, assigneeUserId: "emp-1", createdByUserId: "m", status: status as never, resolvedAt: new Date() },
      });
      const res = await cancel(p.id);
      expect(res.status).toBe(409);
      expect((await problemOf(res))["code"]).toBe("assignment_not_pending");
      expect((await db.assignment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe(status as never);
    }
    expect((await reload(a.id)).status).toBe("assigned");
  });

  it("two concurrent cancels: one 200, one 409, one event", async () => {
    const a = await seed();
    await assign(a.id, "emp-1");
    const [p] = await rowsOf(a.id);
    const results = await Promise.all([cancel(p!.id), cancel(p!.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await eventsOf(a.id)).filter((e) => e.action === "assignment_cancelled")).toHaveLength(1);
  });

  it("unknown id and an assignment on an out-of-scope asset are 404; an accountant is 403", async () => {
    const other = await seed("in_stock", { entity: "welld_it", currency: "EUR" });
    const p = await db.assignment.create({
      data: { assetId: other.id, assigneeUserId: "e", createdByUserId: "m" },
    });
    expect((await cancel(p.id)).status).toBe(404);
    expect((await cancel("nope")).status).toBe(404);
    expect((await db.assignment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("pending");
    as([grant("ledger", "manage", ENTITY)], "welld_ch");
    expect((await cancel(p.id)).status).toBe(403);
  });
});

describe("the after-commit hook (T17 seam)", () => {
  it("runs after the create commits, with the facts a notification needs", async () => {
    const a = await seed();
    const seen: unknown[] = [];
    const spy = spyOn(assignmentHooks, "afterCommit").mockImplementation(async (event) => {
      // Reading through the pool sees only committed data.
      const row = await db.assignment.findUnique({ where: { id: event.assignmentId } });
      seen.push({ event, committed: row?.status });
    });
    try {
      expect((await assign(a.id, "emp-1")).status).toBe(201);
    } finally {
      spy.mockRestore();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      committed: "pending",
      event: {
        kind: "created",
        assetId: a.id,
        assigneeUserId: "emp-1",
        createdByUserId: "mgr-1",
        assetDescription: a.description,
      },
    });
  });

  it("a hook that throws, sync or async, cannot fail or roll back the write", async () => {
    for (const impl of [
      () => {
        throw new Error("boom");
      },
      async () => {
        throw new Error("boom");
      },
    ]) {
      const a = await seed();
      const spy = spyOn(assignmentHooks, "afterCommit").mockImplementation(impl as never);
      try {
        expect((await assign(a.id, "emp-1")).status).toBe(201);
      } finally {
        spy.mockRestore();
      }
      expect(await rowsOf(a.id)).toHaveLength(1);
    }
  });

  it("is not called when the create is refused", async () => {
    const a = await seed("lost");
    const spy = spyOn(assignmentHooks, "afterCommit");
    try {
      await assign(a.id, "emp-1");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
