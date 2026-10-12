/**
 * Reading assets (T12, specs/015-hardware-inventory; AC-3.7, AC-3.8, AC-4.3,
 * AC-5.7, AC-5.8, AC-9.2, AC-10.3, AC-12.10) plus the pure ledger builder.
 * Real routers over the harness, real Postgres; `auth` identities are stubbed.
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
const { assetReadRouter } = await import("./read.routes");
const { assetRegisterRouter } = await import("./register.routes");
const { buildLedger, bookValueAt } = await import("./ledgerView");
const { yearFigure } = await import("../depreciation/schedule");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { __resetIdentityCacheForTests } = await import("../lib/identities");

const app = new OpenAPIHono();
app.route("/", assetReadRouter);
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

const MANAGER = [grant("asset", "manage")];
const ACCOUNTANT = [grant("ledger", "manage")];

let token: string;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

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

function as(permissions: ResolvedPermission[], entity: string | null) {
  __resetAuthzCacheForTests();
  harness.setResolve(resolving(permissions, entity));
}

const get = (path: string, bearer: string | null = token) =>
  app.request(path, { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} });

type Item = Record<string, unknown> & { id: string };
type Page = { items: Item[]; nextCursor: string | null };
const list = async (query = "") => (await (await get(`/assets${query}`)).json()) as Page;
const ids = (page: Page) => page.items.map((i) => i.id);

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

// ─── The pure ledger builder ────────────────────────────────────────────────

const CH_RULE = {
  id: "r",
  effectiveFrom: new Date("2000-01-01"),
  usefulLifeYears: 3,
  firstYearShare: "full" as const,
  lowValueThresholdCents: null,
  residualCents: 100,
};
const at = (d: string) => new Date(`${d}T00:00:00Z`);
const baseAsset = {
  entity: "welld_ch" as const,
  priceCents: 99815,
  purchaseDate: at("2026-09-25"),
  disposedOn: null,
  legacyImported: false,
};

describe("buildLedger", () => {
  it("lists every schedule year with closed flags, ending on the residual (AC-5.1, AC-5.8)", () => {
    const ledger = buildLedger({
      asset: baseAsset,
      rule: CH_RULE,
      stored: [],
      lastClosedYear: null,
      today: at("2026-10-08"),
    });
    expect(ledger.schedule).toEqual([
      { year: 2026, depreciationCents: 33238, closingCents: 66577, closed: false },
      { year: 2027, depreciationCents: 33238, closingCents: 33339, closed: false },
      { year: 2028, depreciationCents: 33239, closingCents: 100, closed: false },
    ]);
    expect(ledger.bookValueCents).toBe(66577);
    expect(ledger.rule).toEqual({
      id: "r",
      effectiveFrom: "2000-01-01",
      usefulLifeYears: 3,
      firstYearShare: "full",
      lowValueThresholdCents: null,
      residualCents: 100,
    });
  });

  it("an ordered asset's schedule starts in its purchase year, like a received one (AC-5.7)", () => {
    const ledger = buildLedger({
      asset: baseAsset,
      rule: CH_RULE,
      stored: [],
      lastClosedYear: null,
      today: at("2026-01-02"),
    });
    expect(ledger.schedule[0]?.year).toBe(2026);
  });

  it("book value stays at the residual after the schedule ended (AC-5.3)", () => {
    expect(
      bookValueAt({ asset: baseAsset, rule: CH_RULE, stored: [], lastClosedYear: null, today: at("2035-06-01") }),
    ).toBe(100);
  });

  it("an asset bought in a later year is not on the books yet: book value 0", () => {
    expect(
      bookValueAt({ asset: baseAsset, rule: CH_RULE, stored: [], lastClosedYear: null, today: at("2025-06-01") }),
    ).toBe(0);
  });

  it("closed years come from the stored rows, not the current rule", () => {
    const ledger = buildLedger({
      asset: baseAsset,
      rule: CH_RULE,
      stored: [
        { year: 2026, depreciationCents: 1, closingCents: 99814, source: "closed" },
      ],
      lastClosedYear: 2026,
      today: at("2027-02-01"),
    });
    expect(ledger.schedule[0]).toEqual({ year: 2026, depreciationCents: 1, closingCents: 99814, closed: true });
    expect(ledger.schedule[1]?.closed).toBe(false);
  });

  it("a disposed asset's schedule stops at the disposal year with zero book value (AC-7.8)", () => {
    const input = {
      asset: { ...baseAsset, disposedOn: at("2027-05-01") },
      rule: CH_RULE,
      stored: [],
      lastClosedYear: null,
      today: at("2028-01-01"),
    };
    const ledger = buildLedger(input);
    expect(ledger.schedule.map((s) => s.year)).toEqual([2026, 2027]);
    expect(ledger.schedule[1]).toMatchObject({ depreciationCents: 0, closingCents: 0 });
    expect(ledger.bookValueCents).toBe(0);
  });

  it("an imported asset continues from its latest imported figure", () => {
    const ledger = buildLedger({
      asset: { ...baseAsset, purchaseDate: at("2024-03-01"), legacyImported: true },
      rule: CH_RULE,
      stored: [
        { year: 2024, depreciationCents: 20000, closingCents: 79815, source: "imported" },
        { year: 2025, depreciationCents: 26578, closingCents: 53255, source: "imported" },
      ],
      lastClosedYear: 2025,
      today: at("2026-06-01"),
    });
    expect(ledger.schedule.map((s) => [s.year, s.closed])).toEqual([
      [2024, true],
      [2025, true],
      [2026, false],
    ]);
    // 3-year life, bought 2024: only 2026 remains, so it takes everything down to the residual.
    expect(ledger.schedule[2]).toMatchObject({ depreciationCents: 53155, closingCents: 100 });
    expect(ledger.bookValueCents).toBe(100);
  });

  it("agrees with yearFigure for open years", () => {
    const ledger = buildLedger({
      asset: baseAsset,
      rule: CH_RULE,
      stored: [],
      lastClosedYear: null,
      today: at("2027-06-01"),
    });
    const fig = yearFigure(
      { priceCents: 99815, purchaseYear: 2026, rule: CH_RULE },
      2027,
    );
    expect(ledger.bookValueCents).toBe(fig.closingCents);
  });
});

// ─── GET /assets ────────────────────────────────────────────────────────────

describe("GET /assets: filters and search", () => {
  it("each filter alone and combined returns exactly the matching set", async () => {
    const a = await seed({ category: "laptop", status: "in_stock", holderUserId: null, invoiceRef: "INV-1", toVerify: false });
    const b = await seed({ category: "phone", status: "assigned", holderUserId: "u-9", invoiceRef: "INV-2", toVerify: true });
    const c = await seed({ category: "laptop", status: "assigned", holderUserId: "u-9", invoiceRef: "INV-1", toVerify: true });
    const d = await seed({ entity: "welld_it", currency: "EUR", category: "laptop", status: "in_stock" });
    as(MANAGER, null);

    expect(new Set(ids(await list()))).toEqual(new Set([a.id, b.id, c.id, d.id]));
    expect(new Set(ids(await list("?entity=welld_it")))).toEqual(new Set([d.id]));
    expect(new Set(ids(await list("?status=assigned")))).toEqual(new Set([b.id, c.id]));
    expect(new Set(ids(await list("?category=phone")))).toEqual(new Set([b.id]));
    expect(new Set(ids(await list("?holderUserId=u-9")))).toEqual(new Set([b.id, c.id]));
    expect(new Set(ids(await list("?toVerify=true")))).toEqual(new Set([b.id, c.id]));
    expect(new Set(ids(await list("?toVerify=false")))).toEqual(new Set([a.id, d.id]));
    expect(new Set(ids(await list("?invoiceRef=INV-1")))).toEqual(new Set([a.id, c.id]));
    expect(
      new Set(ids(await list("?status=assigned&category=laptop&holderUserId=u-9&toVerify=true&invoiceRef=INV-1&entity=welld_ch"))),
    ).toEqual(new Set([c.id]));
    expect(ids(await list("?status=lost"))).toEqual([]);
  });

  it("q matches description or serial number, case-insensitively, and combines with filters (AC-3.8)", async () => {
    const mac = await seed({ description: "MacBook Pro", serialNumber: "C02ABC" });
    const dell = await seed({ description: "Dell XPS", serialNumber: "mac-like-serial", category: "desktop" });
    await seed({ description: "Monitor", serialNumber: "ZZZ" });
    expect(new Set(ids(await list("?q=MACB")))).toEqual(new Set([mac.id]));
    expect(new Set(ids(await list("?q=mac")))).toEqual(new Set([mac.id, dell.id]));
    expect(new Set(ids(await list("?q=c02abc")))).toEqual(new Set([mac.id]));
    expect(new Set(ids(await list("?q=mac&category=desktop")))).toEqual(new Set([dell.id]));
    expect(ids(await list("?q=nomatch"))).toEqual([]);
  });

  it("q treats % and _ literally, not as wildcards", async () => {
    await seed({ description: "plain" });
    const pct = await seed({ description: "100% cotton" });
    const und = await seed({ description: "a_b" });
    expect(ids(await list("?q=%25"))).toEqual([pct.id]);
    expect(ids(await list("?q=_"))).toEqual([und.id]);
  });

  it("a malformed enum or limit is a 422 naming the field", async () => {
    for (const [query, field] of [
      ["?status=weird", "status"],
      ["?category=toaster", "category"],
      ["?entity=welld_xx", "entity"],
      ["?limit=0", "limit"],
      ["?limit=abc", "limit"],
      ["?toVerify=maybe", "toVerify"],
      ["?cursor=%21%21", "cursor"],
    ] as const) {
      const res = await get(`/assets${query}`);
      expect(res.status).toBe(422);
      expect(((await res.json()) as { field: string }).field).toBe(field);
    }
  });
});

describe("GET /assets: order and cursor", () => {
  it("orders by purchase date descending, then id, across pages with a stable cursor", async () => {
    const rows = [];
    for (const d of ["2026-01-01", "2026-05-01", "2026-05-01", "2025-12-31", "2026-05-01"]) {
      rows.push(await seed({ purchaseDate: new Date(d) }));
    }
    const expected = [...rows]
      .sort((x, y) => y.purchaseDate.getTime() - x.purchaseDate.getTime() || (x.id < y.id ? -1 : 1))
      .map((r) => r.id);

    const all = await list();
    expect(ids(all)).toEqual(expected);
    expect(all.nextCursor).toBeNull();

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Page = await list(`?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      seen.push(...ids(page));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(seen).toEqual(expected);
    expect(pages).toBe(3);
  });

  it("a row inserted between pages does not duplicate or skip the rest", async () => {
    for (const d of ["2026-04-01", "2026-03-01", "2026-02-01"]) await seed({ purchaseDate: new Date(d) });
    const first = await list("?limit=1");
    await seed({ purchaseDate: new Date("2026-12-31") }); // sorts before the cursor
    const rest = await list(`?limit=10&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(rest.items).toHaveLength(2);
    expect(ids(rest)).not.toContain(first.items[0]!.id);
  });
});

describe("GET /assets: scope and capability", () => {
  it("applies entity scope: a conditioned grant only sees its own entity", async () => {
    const ch = await seed({});
    await seed({ entity: "welld_it", currency: "EUR" });
    as([grant("asset", "manage", ENTITY)], "welld_ch");
    expect(ids(await list())).toEqual([ch.id]);
    // Asking for the other entity explicitly yields nothing, not an error or a leak.
    expect(ids(await list("?entity=welld_it"))).toEqual([]);
  });

  it("an entity-conditioned grant on a caller with no entity sees an empty list", async () => {
    await seed({});
    as([grant("asset", "manage", ENTITY)], null);
    const res = await get("/assets");
    expect(res.status).toBe(200);
    expect(((await res.json()) as Page).items).toEqual([]);
  });

  it("a caller with neither capability -> 403 on the list; no token -> 401", async () => {
    await seed({});
    as([], "welld_ch");
    expect((await get("/assets")).status).toBe(403);
    expect((await get("/assets", null)).status).toBe(401);
  });

  it("a user holding only asset-unrelated grants is also 403", async () => {
    as([grant("inventory", "access")], "welld_ch");
    expect((await get("/assets")).status).toBe(403);
  });

  it("the entity scope is the union of the two capabilities, per asset", async () => {
    const ch = await seed({});
    const it = await seed({ entity: "welld_it", currency: "EUR" });
    // A manager scoped to CH reads CH only; an accountant scoped to IT reads IT only.
    as([grant("asset", "manage", ENTITY)], "welld_ch");
    expect(ids(await list())).toEqual([ch.id]);
    as([grant("ledger", "manage", ENTITY)], "welld_it");
    expect(ids(await list())).toEqual([it.id]);
  });
});

describe("GET /suppliers", () => {
  const suppliers = async () =>
    ((await (await get("/suppliers")).json()) as { suppliers: string[] }).suppliers;

  it("lists each supplier once, alphabetically, ignoring assets without one", async () => {
    await seed({ supplier: "Digitec" });
    await seed({ supplier: "Acer" });
    await seed({ supplier: "Digitec" });
    await seed({ supplier: null });
    await seed({ supplier: "  " });
    expect(await suppliers()).toEqual(["Acer", "Digitec"]);
  });

  it("folds case and spacing variants into the most used spelling", async () => {
    await seed({ supplier: "DIGITEC" });
    await seed({ supplier: "Digitec" });
    await seed({ supplier: "Digitec " });
    await seed({ supplier: "apple" });
    await seed({ supplier: "Apple" });
    // "Digitec" is used twice once the trailing space is trimmed, "DIGITEC"
    // once. "apple" and "Apple" tie, and the tie goes to the first in
    // code-point order, so the answer never depends on row order.
    expect(await suppliers()).toEqual(["Apple", "Digitec"]);
  });

  it("applies entity scope: suppliers of another entity are not listed", async () => {
    await seed({ supplier: "Digitec" });
    await seed({ entity: "welld_it", currency: "EUR", supplier: "Mediaworld" });
    as([grant("asset", "manage", ENTITY)], "welld_ch");
    expect(await suppliers()).toEqual(["Digitec"]);
    as([grant("ledger", "manage", ENTITY)], "welld_it");
    expect(await suppliers()).toEqual(["Mediaworld"]);
    as([grant("asset", "manage", ENTITY)], null);
    expect(await suppliers()).toEqual([]);
  });

  it("neither capability -> 403; no token -> 401", async () => {
    await seed({ supplier: "Digitec" });
    as([grant("inventory", "access")], "welld_ch");
    expect((await get("/suppliers")).status).toBe(403);
    expect((await get("/suppliers", null)).status).toBe(401);
  });
});

describe("capability projections (AC-9.2)", () => {
  it("inventory-only response has purchasePriceCents and no ledger key, on list and detail", async () => {
    const a = await seed({});
    as(MANAGER, "welld_ch");
    const listed = await list();
    expect(listed.items[0]).toHaveProperty("purchasePriceCents", 99815);
    expect(listed.items[0]).not.toHaveProperty("ledger");
    const detail = (await (await get(`/assets/${a.id}`)).json()) as Item;
    expect(detail).toHaveProperty("purchasePriceCents", 99815);
    expect(detail).not.toHaveProperty("ledger");
    expect(JSON.stringify(detail)).not.toMatch(/bookValue|schedule/);
  });

  it("list items for a ledger holder carry ledger.bookValueCents only", async () => {
    await seed({ purchaseDate: new Date("2020-01-01") });
    as(ACCOUNTANT, "welld_ch");
    const [item] = (await list()).items;
    expect(item?.["ledger"]).toEqual({ bookValueCents: 100 });
    expect(item).toHaveProperty("purchasePriceCents");
  });

  it("detail for a ledger holder has every schedule year, closed flags and rule.effectiveFrom (AC-5.8)", async () => {
    const a = await seed({ purchaseDate: new Date("2026-09-25") });
    as(ACCOUNTANT, "welld_ch");
    const detail = (await (await get(`/assets/${a.id}`)).json()) as {
      ledger: { rule: { effectiveFrom: string }; schedule: { year: number; closed: boolean }[]; bookValueCents: number };
    };
    expect(detail.ledger.rule.effectiveFrom).toBe("2000-01-01");
    expect(detail.ledger.schedule.map((s) => s.year)).toEqual([2026, 2027, 2028]);
    expect(detail.ledger.schedule.every((s) => s.closed === false)).toBe(true);
  });

  it("an ordered asset's schedule starts in its purchase year (AC-5.7)", async () => {
    const a = await seed({ status: "ordered", purchaseDate: new Date("2031-02-01") });
    as(ACCOUNTANT, "welld_ch");
    const detail = (await (await get(`/assets/${a.id}`)).json()) as {
      ledger: { schedule: { year: number }[] };
    };
    expect(detail.ledger.schedule[0]?.year).toBe(2031);
  });

  it("the rule applied is the one in force at the purchase date, not today's", async () => {
    await db.depreciationRule.create({
      data: {
        entity: "welld_ch",
        effectiveFrom: new Date("2030-01-01"),
        usefulLifeYears: 9,
        firstYearShare: "full",
        lowValueThresholdCents: null,
        residualCents: 100,
        createdByUserId: "acc-1",
        createdByEmail: "a@x.ch",
      },
    });
    const old = await seed({ purchaseDate: new Date("2026-01-01") });
    const recent = await seed({ purchaseDate: new Date("2030-06-01") });
    as(ACCOUNTANT, "welld_ch");
    const years = async (id: string) =>
      ((await (await get(`/assets/${id}`)).json()) as { ledger: { schedule: unknown[] } }).ledger.schedule.length;
    expect(await years(old.id)).toBe(3);
    expect(await years(recent.id)).toBe(9);
  });

  it("a caller holding both capabilities gets the ledger, and only for entities the ledger grant covers", async () => {
    const ch = await seed({});
    const it = await seed({ entity: "welld_it", currency: "EUR", purchaseDate: new Date("2026-03-01") });
    // asset unconditioned (both entities); ledger conditioned to the caller's own entity (CH)
    as([grant("asset", "manage"), grant("ledger", "manage", ENTITY)], "welld_ch");
    const listed = await list();
    const byId = new Map(listed.items.map((i) => [i.id, i]));
    expect(byId.get(ch.id)).toHaveProperty("ledger");
    expect(byId.get(it.id)).not.toHaveProperty("ledger");
    const detailIt = (await (await get(`/assets/${it.id}`)).json()) as Item;
    expect(detailIt).not.toHaveProperty("ledger");
    const detailCh = (await (await get(`/assets/${ch.id}`)).json()) as Item;
    expect(detailCh).toHaveProperty("ledger");
  });

  it("closed years are read from asset_year_figure rows", async () => {
    const a = await seed({ purchaseDate: new Date("2025-03-01") });
    await db.fiscalYear.create({
      data: {
        entity: "welld_ch", year: 2025, openingCents: 0, disposalsCents: 0, purchasesCents: 99815,
        depreciationCents: 1, closingCents: 99814, source: "closed", closedByUserId: "acc-1",
      },
    });
    await db.assetYearFigure.create({
      data: {
        assetId: a.id, entity: "welld_ch", year: 2025, openingCents: 0, purchaseCents: 99815,
        depreciationCents: 1, disposalCents: 0, closingCents: 99814, source: "closed",
      },
    });
    as(ACCOUNTANT, "welld_ch");
    const detail = (await (await get(`/assets/${a.id}`)).json()) as {
      ledger: { schedule: { year: number; depreciationCents: number; closed: boolean }[] };
    };
    expect(detail.ledger.schedule[0]).toMatchObject({ year: 2025, depreciationCents: 1, closed: true });
    expect(detail.ledger.schedule[1]?.closed).toBe(false);
  });
});

describe("GET /assets/{id}", () => {
  it("returns the AssetView with live holder and pending assignee names, and the linked invoice file", async () => {
    const file = await db.invoiceFile.create({
      data: {
        entity: "welld_ch", invoiceRef: "INV-1", objectKey: "inventory/welld_ch/x/inv.pdf",
        fileName: "inv.pdf", contentType: "application/pdf", sizeBytes: 10, uploadStatus: "stored",
        createdByUserId: "mgr-1",
      },
    });
    const a = await seed({ status: "assigned", holderUserId: "holder-1", invoiceFileId: file.id, invoiceRef: "INV-1" });
    const b = await seed({ status: "in_stock" });
    await db.assignment.create({ data: { assetId: b.id, assigneeUserId: "pending-1", createdByUserId: "mgr-1" } });

    const da = (await (await get(`/assets/${a.id}`)).json()) as Item;
    expect(da["holder"]).toEqual({ id: "holder-1", name: "Name of holder-1", status: "active" });
    expect(da["invoiceFile"]).toEqual({ id: file.id, fileName: "inv.pdf" });
    expect(da["pendingAssignment"]).toBeNull();

    const db_ = (await (await get(`/assets/${b.id}`)).json()) as Item;
    expect(db_["pendingAssignment"]).toMatchObject({
      assignee: { id: "pending-1", name: "Name of pending-1" },
    });
  });

  it("identities fail soft: an auth outage still serves the asset with an unknown holder", async () => {
    fetchSpy.mockImplementation((async () => {
      throw new Error("auth down");
    }) as unknown as typeof fetch);
    const a = await seed({ status: "assigned", holderUserId: "holder-1" });
    const res = await get(`/assets/${a.id}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Item)["holder"]).toEqual({ id: "holder-1", name: null, status: "unknown" });
  });

  it("shows disposal details for a disposed asset", async () => {
    const a = await seed({
      status: "disposed", disposedOn: new Date("2026-06-01"), disposalReason: "sold", salePriceCents: 5000,
    });
    as(ACCOUNTANT, "welld_ch");
    const body = (await (await get(`/assets/${a.id}`)).json()) as Item & { ledger: { bookValueCents: number } };
    expect(body["disposal"]).toEqual({ disposedOn: "2026-06-01", reason: "sold", salePriceCents: 5000 });
    expect(body.ledger.bookValueCents).toBe(0);
  });

  it("unknown id -> 404; out-of-scope asset -> 404 (not 403)", async () => {
    const it = await seed({ entity: "welld_it", currency: "EUR" });
    as([grant("asset", "manage", ENTITY)], "welld_ch");
    expect((await get(`/assets/${it.id}`)).status).toBe(404);
    expect((await get("/assets/does-not-exist")).status).toBe(404);
  });

  it("a caller with neither capability gets 404 on someone else's asset (AC-4.3), 401 without a token", async () => {
    const a = await seed({ status: "assigned", holderUserId: "someone-else" });
    as([], "welld_ch");
    expect((await get(`/assets/${a.id}`)).status).toBe(404);
    expect((await get(`/assets/${a.id}`, null)).status).toBe(401);
  });

  it("an auth outage on the authorization path is a 503, never an answer", async () => {
    const a = await seed({});
    __resetAuthzCacheForTests();
    harness.setResolve(async () => {
      throw new Error("auth down");
    });
    expect((await get(`/assets/${a.id}`)).status).toBe(503);
    expect((await get("/assets")).status).toBe(503);
  });
});
