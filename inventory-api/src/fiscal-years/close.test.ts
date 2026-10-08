/**
 * Closing a fiscal year (T20, specs/015-hardware-inventory; AC-8.4..AC-8.7,
 * AC-1.7, AC-5.9, AC-6.3, AC-7.4, AC-11.1, ADR-0046). Real routers, real
 * Postgres, real advisory locks.
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
const { fiscalYearReadRouter } = await import("./read.routes");
const { fiscalYearCloseRouter } = await import("./close.routes");
const { assetRegisterRouter } = await import("../assets/register.routes");
const { assetEditRouter } = await import("../assets/edit.routes");
const { disposeRouter } = await import("../ledger/dispose.routes");
const { rulesRouter } = await import("../depreciation/rules.routes");
const { lockEntity } = await import("./guard");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { __resetIdentityCacheForTests } = await import("../lib/identities");
const { eventChanges } = await import("../history/record");

const app = new OpenAPIHono();
for (const r of [
  fiscalYearReadRouter,
  fiscalYearCloseRouter,
  assetRegisterRouter,
  assetEditRouter,
  disposeRouter,
  rulesRouter,
]) {
  app.route("/", r);
}
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
const BOTH = [grant("ledger", "manage", ENTITY), grant("asset", "manage", ENTITY)];

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
  as(BOTH, "welld_ch");
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
const close = (year: number, entity = "welld_ch") => send("POST", `/fiscal-years/${entity}/${year}/close`);
const view = (year: number, entity = "welld_ch") => send("GET", `/fiscal-years/${entity}/${year}`);

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
      purchaseDate: new Date("2025-03-01"),
      purchasePriceCents: 99815,
      status: "in_stock",
      createdByUserId: "seed",
      ...over,
    } as never,
  });
}
const register = (purchaseDate: string, description = "Raced laptop") =>
  send("POST", "/assets", {
    entity: "welld_ch",
    category: "laptop",
    description,
    purchaseDate,
    totalPriceCents: 120000,
  });

describe("closing has an upper bound: the current UTC calendar year", () => {
  const THIS_YEAR = new Date().getUTCFullYear();

  it("the current year is closable; the year after it is refused with year_in_future and nothing is written", async () => {
    await seed({ purchaseDate: new Date(Date.UTC(THIS_YEAR, 0, 15)) });
    expect((await close(THIS_YEAR)).status).toBe(201);

    const figuresBefore = await db.assetYearFigure.count();
    const eventsBefore = await db.assetEvent.count();
    const res = await close(THIS_YEAR + 1);
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: "year_in_future", year: THIS_YEAR + 1 });
    expect(await db.fiscalYear.count({ where: { year: THIS_YEAR + 1 } })).toBe(0);
    expect(await db.assetYearFigure.count()).toBe(figuresBefore);
    expect(await db.assetEvent.count()).toBe(eventsBefore);
  });

  it("a far-future year is refused the same way, before any sequence check", async () => {
    await seed({ purchaseDate: new Date(Date.UTC(THIS_YEAR, 0, 15)) });
    const res = await close(THIS_YEAR + 5);
    expect(res.status).toBe(409);
    expect((await json(res))["code"]).toBe("year_in_future");
  });

  it("the list never marks a future year closable, even right after the current year is closed", async () => {
    await seed({ purchaseDate: new Date(Date.UTC(THIS_YEAR, 0, 15)) });
    await close(THIS_YEAR);
    const years = (await json(await send("GET", "/fiscal-years?entity=welld_ch")))["years"] as Json[];
    const future = years.filter((y) => y["year"] > THIS_YEAR);
    expect(future.length).toBeGreaterThan(0);
    expect(future.every((y) => y["closable"] === false)).toBe(true);
  });
});

describe("closing (AC-8.4)", () => {
  it("writes the fiscal_year row, one figure per asset on the books, and the history event; the view then reads them", async () => {
    const kept = await seed({ purchaseDate: new Date("2025-03-01") });
    const sold = await seed({
      purchaseDate: new Date("2025-02-01"),
      status: "disposed",
      disposedOn: new Date("2025-09-30"),
      disposalReason: "sold",
      salePriceCents: 4000,
    });
    await seed({ purchaseDate: new Date("2026-02-01") }); // bought later: not part of 2025

    const before = await json(await view(2025));
    expect(before["status"]).toBe("open");

    const res = await close(2025);
    expect(res.status).toBe(201);
    const closed = await json(res);
    expect(closed).toMatchObject({ entity: "welld_ch", year: 2025, currency: "CHF", status: "closed" });
    expect(closed["closedAt"]).toBeTruthy();

    // What was shown before closing is what is stored (figures; status/closedAt are what changed).
    expect(closed["rollForward"]).toEqual(before["rollForward"]);
    expect(closed["assets"]).toEqual(before["assets"]);

    const fy = await db.fiscalYear.findFirstOrThrow({ where: { entity: "welld_ch", year: 2025 } });
    expect(fy).toMatchObject({ source: "closed", closedByUserId: "acc-1" });
    expect({
      openingCents: fy.openingCents,
      disposalsCents: fy.disposalsCents,
      purchasesCents: fy.purchasesCents,
      depreciationCents: fy.depreciationCents,
      closingCents: fy.closingCents,
    }).toEqual(before["rollForward"]);
    expect(fy.closingCents).toBe(
      fy.openingCents - fy.disposalsCents + fy.purchasesCents - fy.depreciationCents,
    );

    const figures = await db.assetYearFigure.findMany({ where: { entity: "welld_ch", year: 2025 } });
    expect(figures.map((f) => f.assetId).sort()).toEqual([kept.id, sold.id].sort());
    expect(figures.every((f) => f.source === "closed")).toBe(true);
    expect(figures.reduce((t, f) => t + f.closingCents, 0)).toBe(fy.closingCents);
    const soldFigure = figures.find((f) => f.assetId === sold.id)!;
    expect(soldFigure.disposalCents).toBeGreaterThan(0);
    expect(soldFigure.closingCents).toBe(0);

    const events = await db.assetEvent.findMany({ where: { action: "fiscal_year_closed" } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ assetId: null, entity: "welld_ch", actorUserId: "acc-1" });
    expect(eventChanges(events[0]!.oldValue, events[0]!.newValue)).toEqual([
      { field: "year", from: null, to: 2025 },
    ]);

    // The T19 view now reads the stored rows, and says the same thing.
    const after = await json(await view(2025));
    expect(after["status"]).toBe("closed");
    expect(after["closedAt"]).toBe(closed["closedAt"]);
    expect(after["rollForward"]).toEqual(before["rollForward"]);
    expect(after["assets"]).toEqual(before["assets"]);
  });

  it("the next year opens at the stored closing, and closes in turn (AC-8.3)", async () => {
    await seed({ purchaseDate: new Date("2025-03-01") });
    const y2025 = await json(await close(2025));
    const y2026Before = await json(await view(2026));
    expect(y2026Before["rollForward"]["openingCents"]).toBe(y2025["rollForward"]["closingCents"]);
    const y2026 = await json(await close(2026));
    expect(y2026["rollForward"]).toEqual(y2026Before["rollForward"]);
    expect(y2026["rollForward"]["openingCents"]).toBe(y2025["rollForward"]["closingCents"]);
  });

  it("an entity's first year is closable even though no year precedes it", async () => {
    await seed({ purchaseDate: new Date("2024-05-01") });
    expect((await close(2024)).status).toBe(201);
  });
});

describe("sequence and state errors (AC-8.5)", () => {
  it("previous year open -> 409 previous_year_open; nothing written", async () => {
    await seed({ purchaseDate: new Date("2024-05-01") });
    const res = await close(2025);
    expect(res.status).toBe(409);
    expect((await json(res))["code"]).toBe("previous_year_open");
    expect(await db.fiscalYear.count()).toBe(0);
    expect(await db.assetYearFigure.count()).toBe(0);
    expect(await db.assetEvent.count({ where: { action: "fiscal_year_closed" } })).toBe(0);
  });

  it("skipping a year after a close is also previous_year_open", async () => {
    await seed({ purchaseDate: new Date("2024-05-01") });
    await close(2024);
    const res = await close(2026);
    expect(res.status).toBe(409);
    expect((await json(res))["code"]).toBe("previous_year_open");
  });

  it("a second close of the same year -> 409 already_closed; an earlier one too", async () => {
    await seed({ purchaseDate: new Date("2024-05-01") });
    await close(2024);
    await close(2025);
    for (const year of [2025, 2024]) {
      const res = await close(year);
      expect(res.status).toBe(409);
      expect((await json(res))["code"]).toBe("already_closed");
    }
    expect(await db.fiscalYear.count()).toBe(2);
  });

  it("an entity with no assets -> 409 nothing_to_close", async () => {
    const res = await close(2025);
    expect(res.status).toBe(409);
    expect((await json(res))["code"]).toBe("nothing_to_close");
    expect(await db.fiscalYear.count()).toBe(0);
  });

  it("a year before anything was bought -> 409 nothing_to_close", async () => {
    await seed({ purchaseDate: new Date("2025-05-01") });
    const res = await close(2023);
    expect(res.status).toBe(409);
    expect((await json(res))["code"]).toBe("nothing_to_close");
  });

  it("two simultaneous closes: exactly one 201, the other already_closed, one row, one event", async () => {
    await seed();
    const results = await Promise.all([close(2025), close(2025)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect((await json(loser))["code"]).toBe("already_closed");
    expect(await db.fiscalYear.count()).toBe(1);
    expect(await db.assetEvent.count({ where: { action: "fiscal_year_closed" } })).toBe(1);
    expect(await db.assetYearFigure.count()).toBe(1);
  }, 20_000);

  it("a year with an inconsistent state rolls back as a whole", async () => {
    await seed();
    // Pre-existing figure row for the asset-year: the insert violates the unique key,
    // so nothing of the close may remain (no fiscal_year row, no event).
    const a = await db.asset.findFirstOrThrow();
    await db.assetYearFigure.create({
      data: { assetId: a.id, entity: "welld_ch", year: 2025, openingCents: 0, purchaseCents: 0, depreciationCents: 0, disposalCents: 0, closingCents: 0, source: "closed" },
    });
    const res = await close(2025);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await db.fiscalYear.count()).toBe(0);
    expect(await db.assetEvent.count({ where: { action: "fiscal_year_closed" } })).toBe(0);
  });
});

describe("authorization", () => {
  it("asset:manage alone -> 403; the other entity -> 404; no token -> 401", async () => {
    await seed();
    as([grant("asset", "manage", ENTITY)], "welld_ch");
    expect((await close(2025)).status).toBe(403);
    as(ACCOUNTANT, "welld_ch");
    expect((await close(2025, "welld_it")).status).toBe(404);
    expect((await send("POST", "/fiscal-years/welld_ch/2025/close", undefined, null)).status).toBe(401);
    expect(await db.fiscalYear.count()).toBe(0);
  });

  it("an unconditioned grant may close either entity (AC-9.5)", async () => {
    as([grant("ledger", "manage")], null);
    await seed({ entity: "welld_it", currency: "EUR" });
    expect((await close(2025, "welld_it")).status).toBe(201);
  });
});

describe("a closed year cannot change (AC-8.6, AC-8.7)", () => {
  it("adding a rule and editing / adding open-year assets leave the closed response byte-identical", async () => {
    await seed({ purchaseDate: new Date("2024-03-01") });
    await close(2024);
    const open = await seed({ purchaseDate: new Date("2026-03-01") });
    const first = await (await view(2024)).text();

    const rule = await send("POST", "/rules", {
      entity: "welld_ch",
      effectiveFrom: "2026-01-01",
      usefulLifeYears: 8,
      firstYearShare: "half",
      lowValueThresholdCents: null,
      residualCents: 0,
    });
    expect(rule.status).toBe(201);
    expect((await send("PATCH", `/assets/${open.id}`, { purchasePriceCents: 555555, description: "Edited" })).status).toBe(200);
    expect((await register("2026-06-01")).status).toBe(201);

    expect(await (await view(2024)).text()).toBe(first);
  });

  it("every dated write into the closed year is refused with fiscal_year_closed", async () => {
    const old = await seed({ purchaseDate: new Date("2024-03-01") });
    await close(2024);

    const registered = await register("2024-12-31");
    expect(registered.status).toBe(409);
    expect((await json(registered))["code"]).toBe("fiscal_year_closed");

    const edited = await send("PATCH", `/assets/${old.id}`, { purchasePriceCents: 1 });
    expect(edited.status).toBe(409);
    expect((await json(edited))["code"]).toBe("fiscal_year_closed");

    const disposed = await send("POST", `/assets/${old.id}/dispose`, { disposedOn: "2024-12-01", reason: "scrapped" });
    expect(disposed.status).toBe(409);
    expect((await json(disposed))["code"]).toBe("fiscal_year_closed");

    const rule = await send("POST", "/rules", {
      entity: "welld_ch",
      effectiveFrom: "2024-06-01",
      usefulLifeYears: 3,
      firstYearShare: "full",
      lowValueThresholdCents: null,
      residualCents: 100,
    });
    expect(rule.status).toBe(409);
    expect((await json(rule))["code"]).toBe("fiscal_year_closed");

    expect(await db.asset.count()).toBe(1);
    expect(await db.depreciationRule.count({ where: { createdByUserId: "acc-1" } })).toBe(0);
  });

  it("disposing a closed-year asset in the OPEN year is allowed and does not touch the closed figures", async () => {
    const old = await seed({ purchaseDate: new Date("2024-03-01") });
    await close(2024);
    const first = await (await view(2024)).text();
    const res = await send("POST", `/assets/${old.id}/dispose`, { disposedOn: "2025-02-01", reason: "scrapped" });
    expect(res.status).toBe(200);
    expect(await (await view(2024)).text()).toBe(first);
    const y2025 = await json(await view(2025));
    expect(y2025["rollForward"]["disposalsCents"]).toBe((await json(await view(2024)))["rollForward"]["closingCents"]);
  });

  it("no route reopens a year", async () => {
    await seed();
    await close(2025);
    for (const [method, path] of [
      ["DELETE", "/fiscal-years/welld_ch/2025"],
      ["PUT", "/fiscal-years/welld_ch/2025"],
      ["PATCH", "/fiscal-years/welld_ch/2025"],
      ["POST", "/fiscal-years/welld_ch/2025/reopen"],
      ["DELETE", "/fiscal-years/welld_ch/2025/close"],
    ] as const) {
      const res = await send(method, path, method === "POST" ? undefined : {});
      expect([404, 405]).toContain(res.status);
    }
    expect(await db.fiscalYear.count()).toBe(1);
  });

  it("the database refuses to delete or change what a close wrote", async () => {
    await seed();
    await close(2025);
    await expect((async () => db.$executeRawUnsafe('DELETE FROM "fiscal_year"'))()).rejects.toThrow();
    await expect(
      (async () => db.$executeRawUnsafe('UPDATE "asset_year_figure" SET "closingCents" = 1'))(),
    ).rejects.toThrow();
  });
});

describe("a dated write racing the close ends up in the figures or is refused, never neither (ADR-0046)", () => {
  /** Holds the entity lock until `release()`, so we can queue two requests behind it in a known order. */
  async function holdLock() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => (locked = resolve));
    const held = db.$transaction(
      async (tx) => {
        await lockEntity(tx, "welld_ch");
        locked();
        await gate;
      },
      { timeout: 15_000 },
    );
    await ready;
    return { release, held };
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("close first, then a register dated in that year -> the register is 409 and the asset does not exist", async () => {
    await seed({ purchaseDate: new Date("2025-01-10") });
    const lock = await holdLock();
    const closing = close(2025);
    await sleep(150);
    const registering = register("2025-11-11");
    await sleep(150);
    lock.release();
    await lock.held;
    const [c, r] = await Promise.all([closing, registering]);
    expect(c.status).toBe(201);
    expect(r.status).toBe(409);
    expect((await json(r))["code"]).toBe("fiscal_year_closed");
    expect(await db.asset.count({ where: { description: "Raced laptop" } })).toBe(0);
  }, 30_000);

  it("register first, then the close -> the asset is in the closed figures", async () => {
    await seed({ purchaseDate: new Date("2025-01-10") });
    const lock = await holdLock();
    const registering = register("2025-11-11");
    await sleep(150);
    const closing = close(2025);
    await sleep(150);
    lock.release();
    await lock.held;
    const [r, c] = await Promise.all([registering, closing]);
    expect(r.status).toBe(201);
    expect(c.status).toBe(201);
    const created = await db.asset.findFirstOrThrow({ where: { description: "Raced laptop" } });
    const figure = await db.assetYearFigure.findFirst({ where: { assetId: created.id, year: 2025 } });
    expect(figure?.purchaseCents).toBe(120000);
    expect((await json(c))["assets"].some((a: Json) => a["assetId"] === created.id)).toBe(true);
  }, 30_000);

  it("a disposal dated in the year: close first -> 409; dispose first -> it is in the closed disposals line", async () => {
    const a = await seed({ purchaseDate: new Date("2024-01-10") });
    const b = await seed({ purchaseDate: new Date("2024-01-10") });
    await db.fiscalYear.create({
      data: { entity: "welld_ch", year: 2024, openingCents: 0, disposalsCents: 0, purchasesCents: 0, depreciationCents: 0, closingCents: 0, source: "closed", closedByUserId: "x" },
    });
    // dispose first
    let lock = await holdLock();
    const disposing = send("POST", `/assets/${a.id}/dispose`, { disposedOn: "2025-04-01", reason: "scrapped" });
    await sleep(150);
    const closing = close(2025);
    await sleep(150);
    lock.release();
    await lock.held;
    const [d, c] = await Promise.all([disposing, closing]);
    expect(d.status).toBe(200);
    expect(c.status).toBe(201);
    expect((await json(c))["rollForward"]["disposalsCents"]).toBeGreaterThan(0);

    // close first (2025 is closed now): a disposal dated 2025 is refused
    lock = await holdLock();
    const closing2 = close(2026);
    await sleep(150);
    const disposing2 = send("POST", `/assets/${b.id}/dispose`, { disposedOn: "2026-04-01", reason: "scrapped" });
    await sleep(150);
    lock.release();
    await lock.held;
    const [c2, d2] = await Promise.all([closing2, disposing2]);
    expect(c2.status).toBe(201);
    expect(d2.status).toBe(409);
    expect((await json(d2))["code"]).toBe("fiscal_year_closed");
    expect((await db.asset.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("in_stock");
  }, 30_000);

  it("unsynchronised register/close pairs: the outcome is always consistent", async () => {
    await seed({ purchaseDate: new Date("2025-01-10") });
    const outcomes: string[] = [];
    const tasks = Array.from({ length: 6 }, (_, i) => register("2025-06-01", `Race ${i}`));
    const [c, ...registered] = await Promise.all([close(2025), ...tasks]);
    expect(c.status).toBe(201);
    const closedIds = new Set(((await json(c))["assets"] as Json[]).map((a) => a["assetId"]));
    for (let i = 0; i < registered.length; i++) {
      const created = await db.asset.findFirst({ where: { description: `Race ${i}` } });
      if (registered[i]!.status === 201) {
        expect(created).not.toBeNull();
        expect(closedIds.has(created!.id)).toBe(true);
        outcomes.push("included");
      } else {
        expect(registered[i]!.status).toBe(409);
        expect(created).toBeNull();
        outcomes.push("refused");
      }
    }
    expect(outcomes).toHaveLength(6);
  }, 30_000);
});
