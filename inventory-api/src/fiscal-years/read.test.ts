/**
 * Fiscal years: list and roll-forward view (T19, specs/015-hardware-inventory;
 * AC-8.1, AC-8.2, AC-8.3, AC-7.2, AC-7.3, AC-9.4, ADR-0046). Real router +
 * middleware over the harness, real Postgres.
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
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { __resetIdentityCacheForTests } = await import("../lib/identities");

const app = new OpenAPIHono();
app.route("/", fiscalYearReadRouter);
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
const ACCOUNTANT_CH = [grant("ledger", "manage", ENTITY)];

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
  as(ACCOUNTANT_CH, "welld_ch");
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

const get = (path: string, bearer: string | null = token) =>
  app.request(path, { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} });

type Json = Record<string, any>;
const json = async (res: Response) => (await res.json()) as Json;

const THIS_YEAR = new Date().getUTCFullYear();

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
const closeRaw = (entity: "welld_ch" | "welld_it", year: number, lines = [0, 0, 0, 0, 0]) =>
  db.fiscalYear.create({
    data: {
      entity,
      year,
      openingCents: lines[0]!,
      disposalsCents: lines[1]!,
      purchasesCents: lines[2]!,
      depreciationCents: lines[3]!,
      closingCents: lines[4]!,
      source: "closed",
      closedByUserId: "acc-9",
    },
  });
const figureRaw = (
  assetId: string,
  entity: "welld_ch" | "welld_it",
  year: number,
  f: { o: number; p: number; d: number; x: number; c: number },
  source: "closed" | "imported" = "closed",
) =>
  db.assetYearFigure.create({
    data: {
      assetId,
      entity,
      year,
      openingCents: f.o,
      purchaseCents: f.p,
      depreciationCents: f.d,
      disposalCents: f.x,
      closingCents: f.c,
      source,
    },
  });

const equation = (l: Json) =>
  l["openingCents"] - l["disposalsCents"] + l["purchasesCents"] - l["depreciationCents"];

describe("GET /fiscal-years?entity", () => {
  it("an entity with no assets has no years", async () => {
    const res = await get("/fiscal-years?entity=welld_ch");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ years: [] });
  });

  it("lists first purchase year to the current year, all open; only the first is closable", async () => {
    await seed({ purchaseDate: new Date("2024-02-01") });
    await seed({ purchaseDate: new Date("2025-02-01") });
    const { years } = await json(await get("/fiscal-years?entity=welld_ch"));
    expect(years.map((y: Json) => y["year"])).toEqual(
      Array.from({ length: THIS_YEAR - 2024 + 1 }, (_, i) => 2024 + i),
    );
    expect(years.every((y: Json) => y["status"] === "open" && y["closedAt"] === null)).toBe(true);
    expect(years.filter((y: Json) => y["closable"]).map((y: Json) => y["year"])).toEqual([2024]);
  });

  it("closed years carry closedAt; the year after the last closed one is closable", async () => {
    await seed({ purchaseDate: new Date("2024-02-01") });
    const fy = await closeRaw("welld_ch", 2024);
    const { years } = await json(await get("/fiscal-years?entity=welld_ch"));
    const y2024 = years.find((y: Json) => y["year"] === 2024);
    expect(y2024).toEqual({ year: 2024, status: "closed", closedAt: fy.closedAt.toISOString(), closable: false });
    expect(years.filter((y: Json) => y["closable"]).map((y: Json) => y["year"])).toEqual([2025]);
  });

  it("closing the current year makes next year appear", async () => {
    await seed({ purchaseDate: new Date(`${THIS_YEAR}-01-05`) });
    await closeRaw("welld_ch", THIS_YEAR);
    const { years } = await json(await get("/fiscal-years?entity=welld_ch"));
    expect(years.map((y: Json) => y["year"])).toEqual([THIS_YEAR, THIS_YEAR + 1]);
  });

  it("other entity -> 404; capability absent -> 403; no token -> 401", async () => {
    expect((await get("/fiscal-years?entity=welld_it")).status).toBe(404);
    as([grant("asset", "manage", ENTITY)], "welld_ch");
    expect((await get("/fiscal-years?entity=welld_ch")).status).toBe(403);
    expect((await get("/fiscal-years?entity=welld_ch", null)).status).toBe(401);
  });

  it("an unconditioned grant covers both entities (AC-9.5)", async () => {
    as([grant("ledger", "manage")], null);
    expect((await get("/fiscal-years?entity=welld_it")).status).toBe(200);
  });
});

describe("GET /fiscal-years/{entity}/{year}: an open year", () => {
  it("shows the five lines and per-asset rows with opening and purchase (AC-8.1, 8.2)", async () => {
    const old = await seed({ purchaseDate: new Date("2025-03-01"), holderUserId: "emp-1", status: "assigned", serialNumber: "SN-1" });
    const fresh = await seed({ purchaseDate: new Date(`${THIS_YEAR}-02-01`), purchasePriceCents: 120000 });
    const res = await get(`/fiscal-years/welld_ch/${THIS_YEAR}`);
    expect(res.status).toBe(200);
    const v = await json(res);
    expect(v).toMatchObject({ entity: "welld_ch", year: THIS_YEAR, currency: "CHF", status: "open", closedAt: null });

    // 99815 / CH: 33238, 33238, 33239; 2025 and 2026 depreciated
    const oldRow = v["assets"].find((a: Json) => a["assetId"] === old.id);
    expect(oldRow).toMatchObject({
      description: old.description,
      serialNumber: "SN-1",
      purchasePriceCents: 99815,
      holder: { id: "emp-1", name: "Name of emp-1", status: "active" },
    });
    if (THIS_YEAR === 2026) {
      expect(oldRow).toMatchObject({
        openingCents: 99815 - 33238,
        purchaseCents: 0,
        depreciationCents: 33238,
        disposalCents: 0,
        closingCents: 99815 - 66476,
      });
    }
    const freshRow = v["assets"].find((a: Json) => a["assetId"] === fresh.id);
    expect(freshRow).toMatchObject({ openingCents: 0, purchaseCents: 120000, disposalCents: 0 });
    expect(freshRow.holder).toBeNull();

    const rf = v["rollForward"];
    expect(rf["closingCents"]).toBe(equation(rf));
    for (const [line, key] of [
      ["openingCents", "openingCents"],
      ["disposalsCents", "disposalCents"],
      ["purchasesCents", "purchaseCents"],
      ["depreciationCents", "depreciationCents"],
      ["closingCents", "closingCents"],
    ] as const) {
      expect(rf[line]).toBe(v["assets"].reduce((t: number, a: Json) => t + a[key], 0));
    }
  });

  it("opening(Y+1) = closing(Y) across consecutive open years", async () => {
    await seed({ purchaseDate: new Date("2023-03-01") });
    await seed({ purchaseDate: new Date("2024-07-01"), purchasePriceCents: 250000 });
    let previous: number | null = null;
    for (let y = 2023; y <= THIS_YEAR; y++) {
      const rf = (await json(await get(`/fiscal-years/welld_ch/${y}`)))["rollForward"];
      if (previous !== null) expect(rf["openingCents"]).toBe(previous);
      previous = rf["closingCents"];
    }
  });

  it("a disposal puts the written-off book value on the disposals line of its year only (AC-7.2, 7.7)", async () => {
    const a = await seed({ purchaseDate: new Date("2024-03-01"), status: "disposed", disposedOn: new Date("2025-06-30"), disposalReason: "scrapped" });
    const y2024 = (await json(await get("/fiscal-years/welld_ch/2024")))["rollForward"];
    const y2025 = (await json(await get("/fiscal-years/welld_ch/2025")))["rollForward"];
    expect(y2025["disposalsCents"]).toBe(y2024["closingCents"]);
    expect(y2025["depreciationCents"]).toBe(0);
    expect(y2025["closingCents"]).toBe(0);
    const y2026 = await json(await get("/fiscal-years/welld_ch/2026"));
    expect(y2026["assets"]).toEqual([]);
    expect(y2026["rollForward"]).toEqual({ openingCents: 0, disposalsCents: 0, purchasesCents: 0, depreciationCents: 0, closingCents: 0 });
    expect(a.id).toBeTruthy();
  });

  it("a sale price changes no line and no figure (AC-7.3)", async () => {
    const a = await seed({ purchaseDate: new Date("2024-03-01"), status: "disposed", disposedOn: new Date("2025-06-30"), disposalReason: "sold" });
    const before = await (await get("/fiscal-years/welld_ch/2025")).text();
    await db.asset.update({ where: { id: a.id }, data: { salePriceCents: 50000 } });
    expect(await (await get("/fiscal-years/welld_ch/2025")).text()).toBe(before);
  });

  it("an IT asset under the low-value threshold: bought and written off in the same year, not on the books after", async () => {
    as([grant("ledger", "manage")], null);
    await seed({ entity: "welld_it", currency: "EUR", purchaseDate: new Date("2025-05-01"), purchasePriceCents: 30000 });
    const y2025 = (await json(await get("/fiscal-years/welld_it/2025")))["rollForward"];
    expect(y2025).toEqual({ openingCents: 0, disposalsCents: 0, purchasesCents: 30000, depreciationCents: 30000, closingCents: 0 });
    const y2026 = await json(await get("/fiscal-years/welld_it/2026"));
    expect(y2026["assets"]).toEqual([]);
    expect(y2026["currency"]).toBe("EUR");
  });

  it("rows are ordered by purchase date, description, id - the same every time", async () => {
    await seed({ purchaseDate: new Date("2025-09-01"), description: "B" });
    await seed({ purchaseDate: new Date("2025-01-01"), description: "Z" });
    await seed({ purchaseDate: new Date("2025-01-01"), description: "A" });
    const v = await json(await get("/fiscal-years/welld_ch/2025"));
    expect(v["assets"].map((a: Json) => a["description"])).toEqual(["A", "Z", "B"]);
  });

  it("the other entity's assets are not in it", async () => {
    await seed();
    as([grant("ledger", "manage")], null);
    await seed({ entity: "welld_it", currency: "EUR", description: "IT only" });
    as(ACCOUNTANT_CH, "welld_ch");
    const v = await json(await get("/fiscal-years/welld_ch/2025"));
    expect(v["assets"].map((a: Json) => a["description"])).not.toContain("IT only");
  });
});

describe("GET /fiscal-years/{entity}/{year}: a closed year", () => {
  it("is read from the stored rows only, whatever the rules and prices say now (AC-8.6)", async () => {
    const a = await seed({ purchaseDate: new Date("2024-03-01") });
    // Figures that the formula would never produce.
    await figureRaw(a.id, "welld_ch", 2024, { o: 0, p: 99815, d: 11111, x: 0, c: 88704 });
    await closeRaw("welld_ch", 2024, [0, 0, 99815, 11111, 88704]);

    const first = await (await get("/fiscal-years/welld_ch/2024")).text();
    const v = JSON.parse(first) as Json;
    expect(v).toMatchObject({ status: "closed" });
    expect(v["closedAt"]).toBeTruthy();
    expect(v["rollForward"]).toEqual({ openingCents: 0, disposalsCents: 0, purchasesCents: 99815, depreciationCents: 11111, closingCents: 88704 });
    expect(v["assets"][0]).toMatchObject({ openingCents: 0, purchaseCents: 99815, depreciationCents: 11111, disposalCents: 0, closingCents: 88704 });

    // A new (future-dated) rule, and an edit of another asset: nothing moves.
    await db.depreciationRule.create({
      data: { entity: "welld_ch", effectiveFrom: new Date("2030-01-01"), usefulLifeYears: 9, firstYearShare: "half", residualCents: 0, createdByUserId: "x", createdByEmail: "x@x" },
    });
    await seed({ purchaseDate: new Date("2026-01-10") });
    expect(await (await get("/fiscal-years/welld_ch/2024")).text()).toBe(first);
  });

  it("the open year after it opens at the STORED closing (AC-8.3)", async () => {
    const a = await seed({ purchaseDate: new Date("2024-03-01") });
    await figureRaw(a.id, "welld_ch", 2025, { o: 70000, p: 0, d: 20000, x: 0, c: 50000 });
    await closeRaw("welld_ch", 2025, [70000, 0, 0, 20000, 50000]);
    const v = await json(await get("/fiscal-years/welld_ch/2026"));
    expect(v["rollForward"]["openingCents"]).toBe(50000);
    expect(v["rollForward"]["closingCents"]).toBe(equation(v["rollForward"]));
    expect(v["assets"][0]["openingCents"]).toBe(50000);
  });

  it("imported closing-only history is shown as stored and invents nothing", async () => {
    const a = await seed({ purchaseDate: new Date("2021-03-01"), legacyImported: true });
    await figureRaw(a.id, "welld_ch", 2023, { o: 0, p: 0, d: 0, x: 0, c: 53255 }, "imported");
    await figureRaw(a.id, "welld_ch", 2024, { o: 0, p: 0, d: 0, x: 0, c: 53255 }, "imported");
    await closeRaw("welld_ch", 2024, [0, 0, 0, 0, 53255]);
    const v = await json(await get("/fiscal-years/welld_ch/2024"));
    expect(v["rollForward"]["closingCents"]).toBe(53255);
    expect(v["assets"]).toHaveLength(1);
    // 2023 is closed too (<= the latest closed year) but has no fiscal_year row of its own:
    // its lines are the sums of the stored per-asset rows, and no close time is invented.
    const earlier = await json(await get("/fiscal-years/welld_ch/2023"));
    expect(earlier).toMatchObject({ status: "closed", closedAt: null });
    expect(earlier["rollForward"]["closingCents"]).toBe(53255);
    // The sheet has nothing before 2023: that is where the entity's years begin.
    expect((await get("/fiscal-years/welld_ch/2022")).status).toBe(404);
    // And the open year continues from the sheet's value, not from a recomputation of the purchase.
    const next = await json(await get("/fiscal-years/welld_ch/2025"));
    expect(next["rollForward"]["openingCents"]).toBe(53255);
  });
});

describe("not found", () => {
  it("before the entity's first year, beyond the horizon, other entity, empty entity", async () => {
    await seed({ purchaseDate: new Date("2024-03-01") });
    expect((await get("/fiscal-years/welld_ch/2023")).status).toBe(404);
    expect((await get("/fiscal-years/welld_ch/2024")).status).toBe(200);
    expect((await get(`/fiscal-years/welld_ch/${THIS_YEAR + 1}`)).status).toBe(404);
    expect((await get("/fiscal-years/welld_it/2024")).status).toBe(404);
    as([grant("ledger", "manage")], null);
    expect((await get("/fiscal-years/welld_it/2024")).status).toBe(404); // no assets: no first year
  });

  it("a bad year or entity is a 422", async () => {
    expect((await get("/fiscal-years/welld_ch/abc")).status).toBe(422);
    expect((await get("/fiscal-years/mars/2025")).status).toBe(422);
  });

  it("asset:manage alone -> 403", async () => {
    as([grant("asset", "manage", ENTITY)], "welld_ch");
    expect((await get("/fiscal-years/welld_ch/2025")).status).toBe(403);
  });
});

describe("R-8: 2,000 assets", () => {
  it("the open-year view answers in under 500 ms", async () => {
    const data = Array.from({ length: 2000 }, (_, i) => ({
      entity: "welld_ch" as const,
      currency: "CHF" as const,
      category: "laptop" as const,
      description: `Bulk ${i}`,
      purchaseDate: new Date(Date.UTC(2020 + (i % 7), i % 12, 1 + (i % 27))),
      purchasePriceCents: 50000 + i * 37,
      status: i % 5 === 0 ? ("assigned" as const) : ("in_stock" as const),
      holderUserId: i % 5 === 0 ? `emp-${i}` : null,
      createdByUserId: "seed",
      ...(i % 11 === 0
        ? { status: "disposed" as const, disposedOn: new Date(Date.UTC(THIS_YEAR, 3, 1)), disposalReason: "scrapped" as const, holderUserId: null }
        : {}),
    }));
    await db.asset.createMany({ data: data as never });

    await get(`/fiscal-years/welld_ch/${THIS_YEAR}`); // warm the connection and caches
    const t0 = performance.now();
    const res = await get(`/fiscal-years/welld_ch/${THIS_YEAR}`);
    const ms = performance.now() - t0;
    console.log(`[R-8] GET /fiscal-years/welld_ch/${THIS_YEAR} with 2000 assets: ${ms.toFixed(0)} ms`);
    expect(res.status).toBe(200);
    expect((await json(res))["assets"].length).toBeGreaterThan(1000);
    expect(ms).toBeLessThan(500);
  }, 60_000);
});
