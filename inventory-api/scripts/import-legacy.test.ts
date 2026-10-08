/**
 * The legacy import end to end (T23, specs/015-hardware-inventory; AC-12.1 to
 * AC-12.9): a SYNTHETIC workbook written to a temp file, the real script entry
 * (`runImport`), real Postgres. The real register is never used here.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["DATABASE_URL"] ??= "postgresql://test:test@localhost:5435/inventory";

const { db } = await import("../src/lib/db");
const { truncateInventoryTables } = await import("../src/test-support/dbCleanup");
const { lockEntity } = await import("../src/fiscal-years/guard");
const { eventChanges } = await import("../src/history/record");
const { loadEntityContext, ruleResolver, toRollAsset } = await import("../src/fiscal-years/read.repo");
const { buildStatement } = await import("../src/fiscal-years/rollForward");
const { runImport } = await import("./import-legacy");
const { applyPlan } = await import("./legacy/apply");
const { parseSheet } = await import("./legacy/parse");
const { buildPlan } = await import("./legacy/plan");
const { FIXTURE, fixtureRows, writeWorkbook, toSheetRows, row } = await import("./legacy/testFixture");
type FixtureRows = ReturnType<typeof fixtureRows>;

let dir: string;
let xlsx: string;
let usersJson: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "import-legacy-test-"));
  usersJson = join(dir, "users.json");
  await writeFile(usersJson, JSON.stringify(FIXTURE.users.map((u) => ({ ...u, email: "ignored@example.test" }))));
  xlsx = join(dir, "register.xlsx");
});
afterAll(async () => {
  await truncateInventoryTables();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await truncateInventoryTables();
  await writeWorkbook(xlsx, fixtureRows());
});

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (l: string) => void out.push(l), error: (l: string) => void err.push(l) };
}
const run = async (over: Partial<Parameters<typeof runImport>[0]> = {}, channel = io()) => {
  const code = await runImport(
    { file: xlsx, userMapPath: usersJson, expectedOpeningCents: FIXTURE.closing2025Cents, apply: true, ...over },
    channel,
  );
  return { code, ...channel };
};

const counts = async () => ({
  assets: await db.asset.count(),
  figures: await db.assetYearFigure.count(),
  fiscalYears: await db.fiscalYear.count(),
  events: await db.assetEvent.count(),
  assignments: await db.assignment.count(),
});
const NOTHING = { assets: 0, figures: 0, fiscalYears: 0, events: 0, assignments: 0 };
const byRow = async (sheetRow: number) => {
  const events = await db.assetEvent.findMany({ where: { action: "imported" } });
  const ids = events
    .filter((e) => eventChanges(e.oldValue, e.newValue).some((c) => c.field === "sheetRow" && c.to === sheetRow))
    .map((e) => e.assetId!);
  return db.asset.findMany({ where: { id: { in: ids } }, orderBy: { purchasePriceCents: "asc" } });
};
const rewrite = async (mutate: (rows: FixtureRows) => void) => {
  const rows = fixtureRows();
  mutate(rows);
  await writeWorkbook(xlsx, rows);
};

describe("dry run is the default", () => {
  it("prints the report and writes nothing", async () => {
    const r = await run({ apply: false });
    expect(r.code).toBe(0);
    expect(await counts()).toEqual(NOTHING);
    const text = r.out.join("\n");
    expect(text).toContain("DRY RUN");
    expect(text).toContain("Assets to create: 19");
    expect(text).toContain("row 6 -> 13 units");
    expect(text).toContain("1,851.13");
    expect(text).toContain("Dry run: nothing was written");
  });

  it("works without the expected balance, and says it did not check it", async () => {
    const r = await run({ apply: false, expectedOpeningCents: undefined });
    expect(r.code).toBe(0);
    expect(r.out.join("\n")).toContain("not given, not checked");
  });

  it("reports a wrong expected balance and exits 1, still writing nothing", async () => {
    const r = await run({ apply: false, expectedOpeningCents: FIXTURE.closing2025Cents + 1 });
    expect(r.code).toBe(1);
    expect(r.out.join("\n")).toContain("DOES NOT MATCH");
    expect(await counts()).toEqual(NOTHING);
  });

  it("prints no row content: no description, serial or name", async () => {
    const r = await run({ apply: false });
    const text = [...r.out, ...r.err].join("\n");
    for (const secret of ["Synthetic", "SYN-", "Nobody Known", "Twin", "Ada"]) expect(text).not.toContain(secret);
  });
});

describe("--apply needs the expected balance (AC-12.4)", () => {
  it("is a usage error without it", async () => {
    const r = await run({ expectedOpeningCents: undefined });
    expect(r.code).toBe(2);
    expect(await counts()).toEqual(NOTHING);
  });

  it("a wrong balance exits 1 with zero rows written in every table", async () => {
    for (const wrong of [0, FIXTURE.closing2025Cents - 1, FIXTURE.closing2025Cents + 1, 2_975_649]) {
      const r = await run({ expectedOpeningCents: wrong });
      expect(r.code).toBe(1);
      expect(r.err.join("\n")).toContain("Nothing was written");
      expect(await counts()).toEqual(NOTHING);
    }
  });

  it("the right balance imports", async () => {
    const r = await run();
    expect(r.code).toBe(0);
    expect((await counts()).assets).toBe(FIXTURE.importedAssets);
  });
});

describe("what the apply writes", () => {
  it("AC-12.1 every purchase row exists as welld_ch assets with date, description and price; the 13-unit row as 13", async () => {
    expect((await run()).code).toBe(0);
    const all = await db.asset.findMany();
    expect(all).toHaveLength(19);
    expect(all.every((a) => a.entity === "welld_ch" && a.currency === "CHF" && a.legacyImported)).toBe(true);
    expect(all.every((a) => a.createdByUserId === "system:legacy-import")).toBe(true);

    const r2 = (await byRow(2))[0]!;
    expect(r2).toMatchObject({ description: "Synthetic MacBook Pro 14 A", serialNumber: "SYN-A", purchasePriceCents: 150_000, category: "laptop" });
    expect(r2.purchaseDate.toISOString().slice(0, 10)).toBe("2022-03-15"); // a text date
    expect((await byRow(3))[0]!.purchaseDate.toISOString().slice(0, 10)).toBe("2023-06-01"); // a typed date

    const units = await byRow(6);
    expect(units).toHaveLength(13);
    expect(units.reduce((s, u) => s + u.purchasePriceCents, 0)).toBe(294_635);
    expect(Math.max(...units.map((u) => u.purchasePriceCents))).toBe(22_667); // remainder on the last
    expect(units.every((u) => u.serialNumber === null && u.status === "in_stock" && u.toVerify)).toBe(true);
  });

  it("AC-12.2 the imported figures are the sheet's amounts in cents, source imported", async () => {
    await run();
    const r3 = (await byRow(3))[0]!;
    const figs = await db.assetYearFigure.findMany({ where: { assetId: r3.id }, orderBy: { year: "asc" } });
    expect(figs.map((f) => [f.year, f.openingCents, f.purchaseCents, f.depreciationCents, f.disposalCents, f.closingCents, f.source, f.entity])).toEqual([
      [2023, 60_033, 0, 0, 0, 60_033, "imported", "welld_ch"],
      [2024, 60_033, 0, 29_967, 0, 30_066, "imported", "welld_ch"],
      [2025, 30_066, 0, 29_966, 0, 100, "imported", "welld_ch"],
    ]);
    const r4 = (await byRow(4))[0]!;
    const r4figs = await db.assetYearFigure.findMany({ where: { assetId: r4.id }, orderBy: { year: "asc" } });
    expect(r4figs.map((f) => f.year)).toEqual([2024, 2025]); // bought in 2024: no 2023
    expect(r4figs[1]!.closingCents).toBe(40_066);
    // 2026 purchases and the ordered row: no imported rows
    expect(await db.assetYearFigure.count({ where: { assetId: (await byRow(5))[0]!.id } })).toBe(0);
  });

  it("AC-12.3 fiscal years 2024 and 2025 are closed, imported, and equal the sums of the rows", async () => {
    await run();
    const years = await db.fiscalYear.findMany({ orderBy: { year: "asc" } });
    expect(years.map((y) => [y.entity, y.year, y.source, y.closedByUserId])).toEqual([
      ["welld_ch", 2024, "imported", "system:legacy-import"],
      ["welld_ch", 2025, "imported", "system:legacy-import"],
    ]);
    for (const y of years) {
      const sum = await db.assetYearFigure.aggregate({
        where: { entity: "welld_ch", year: y.year },
        _sum: { openingCents: true, purchaseCents: true, depreciationCents: true, disposalCents: true, closingCents: true },
      });
      expect([y.openingCents, y.purchasesCents, y.depreciationCents, y.disposalsCents, y.closingCents]).toEqual([
        sum._sum.openingCents!,
        sum._sum.purchaseCents!,
        sum._sum.depreciationCents!,
        sum._sum.disposalCents!,
        sum._sum.closingCents!,
      ]);
    }
    expect(years[1]!.closingCents).toBe(FIXTURE.closing2025Cents);
    expect(years[1]!.openingCents).toBe(years[0]!.closingCents);
  });

  it("AC-12.4 the books at 31.12.2025 add up to the confirmed figure", async () => {
    await run();
    const sum = await db.assetYearFigure.aggregate({ where: { year: 2025 }, _sum: { closingCents: true } });
    expect(sum._sum.closingCents).toBe(FIXTURE.closing2025Cents);
  });

  it("AC-12.6 / 12.7 holders and the to-verify mark", async () => {
    await run();
    const r2 = (await byRow(2))[0]!;
    expect(r2).toMatchObject({ status: "assigned", holderUserId: "u-ada", toVerify: false });
    const asg = await db.assignment.findMany();
    expect(asg).toHaveLength(1);
    expect(asg[0]).toMatchObject({
      assetId: r2.id,
      assigneeUserId: "u-ada",
      status: "confirmed",
      createdByUserId: "system:legacy-import",
    });
    expect(asg[0]!.resolvedAt).not.toBeNull();

    expect(await byRow(4)).toMatchObject([{ status: "in_stock", holderUserId: null, toVerify: true, locationNote: null }]);
    expect(await byRow(3)).toMatchObject([{ status: "in_stock", holderUserId: null, toVerify: true, locationNote: "Nobody Known" }]);
    expect(await byRow(8)).toMatchObject([{ status: "in_stock", holderUserId: null, toVerify: true, locationNote: "Twin Name" }]); // two matches
    expect(await db.asset.count({ where: { toVerify: true } })).toBe(16);
  });

  it("AC-12.8 a cession is a 2026 disposal of the asset its serial names, not a new asset", async () => {
    await run();
    const r9 = (await byRow(9))[0]!;
    expect(r9).toMatchObject({ status: "disposed", holderUserId: null, disposalReason: "ceded_to_employee", salePriceCents: 100, toVerify: false });
    expect(r9.disposedOn?.toISOString().slice(0, 10)).toBe("2026-03-15");
    expect(await db.asset.count({ where: { status: "disposed" } })).toBe(1);
    expect(await db.asset.count({ where: { serialNumber: "SYN-NOMATCH" } })).toBe(0);
    const events = await db.assetEvent.findMany({ where: { assetId: r9.id }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.action)).toEqual(["imported", "disposed"]);
  });

  it("AC-12.9 the order not received is `ordered` with no serial", async () => {
    await run();
    expect((await byRow(5))[0]).toMatchObject({ status: "ordered", serialNumber: null, holderUserId: null, locationNote: "Ada Synthetic" });
  });

  it("the spec O5 cases are reported with their row and not imported", async () => {
    const r = await run();
    const text = r.out.join("\n");
    expect(text).toContain("row 7:");
    expect(text).toContain("row 13:");
    expect(await db.asset.count({ where: { description: "Synthetic orphan" } })).toBe(0);
  });

  it("every asset has an `imported` history event by the import actor, with its sheet row", async () => {
    await run();
    const events = await db.assetEvent.findMany({ where: { action: "imported" } });
    expect(events).toHaveLength(19);
    expect(events.every((e) => e.actorUserId === "system:legacy-import" && e.entity === "welld_ch")).toBe(true);
    expect(new Set(events.map((e) => e.assetId)).size).toBe(19);
  });

  it("the module continues from the books: 2026 is computed from the imported 2025 closing (AC-12.5)", async () => {
    await run();
    const ctx = await loadEntityContext(db, "welld_ch");
    expect(ctx.lastClosedYear).toBe(2025);
    const st = buildStatement({
      assets: ctx.assets.map(toRollAsset),
      rule: ruleResolver(ctx),
      stored: ctx.stored,
      lastClosedYear: ctx.lastClosedYear,
      year: 2026,
    });
    const ofRow = async (n: number) => {
      const id = (await byRow(n))[0]!.id;
      return st.rows.find((r) => r.assetId === id)!;
    };
    // r4: V = 400.66, one year left -> down to CHF 1.00 in 2026
    expect(await ofRow(4)).toMatchObject({ openingCents: 40_066, depreciationCents: 39_966, closingCents: 100 });
    // r8: V = 466.68, two years left -> (466.68 - 1.00) / 2 = 232.84 a year
    expect(await ofRow(8)).toMatchObject({ openingCents: 46_668, depreciationCents: 23_284, closingCents: 23_384 });
    // the open year opens on the closed year's closing, as imported
    expect(st.lines.openingCents).toBe(FIXTURE.closing2025Cents);
    // 2025 is read from the stored rows
    const st25 = buildStatement({
      assets: ctx.assets.map(toRollAsset),
      rule: ruleResolver(ctx),
      stored: ctx.stored,
      lastClosedYear: ctx.lastClosedYear,
      year: 2025,
    });
    expect(st25.lines.closingCents).toBe(FIXTURE.closing2025Cents);
  });
});

describe("it is safe to run twice, and to run at the wrong time", () => {
  it("running twice does not duplicate anything", async () => {
    expect((await run()).code).toBe(0);
    const first = await counts();
    const again = await run();
    expect(again.code).toBe(0);
    expect(again.out.join("\n")).toContain("Already imported");
    expect(await counts()).toEqual(first);
  });

  it("a second run with a wrong balance is refused: it verifies, it does not trust", async () => {
    await run();
    const first = await counts();
    const again = await run({ expectedOpeningCents: FIXTURE.closing2025Cents + 5 });
    expect(again.code).toBe(1);
    expect(await counts()).toEqual(first);
  });

  it("two runs at the same moment import once", async () => {
    const [a, b] = await Promise.all([run(), run()]);
    expect([a.code, b.code]).toEqual([0, 0]);
    expect((await counts()).assets).toBe(19);
    expect((await counts()).fiscalYears).toBe(2);
    expect([a, b].filter((r) => r.out.join("\n").includes("Already imported"))).toHaveLength(1);
  }, 30_000);

  it("refuses an entity that already has assets of its own, and writes nothing", async () => {
    await db.asset.create({
      data: {
        entity: "welld_ch",
        currency: "CHF",
        category: "laptop",
        description: "Registered by hand",
        purchaseDate: new Date("2026-01-05"),
        purchasePriceCents: 100_000,
        status: "in_stock",
        createdByUserId: "u-1",
      },
    });
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("already holds assets");
    expect(await db.asset.count()).toBe(1);
    expect(await db.fiscalYear.count()).toBe(0);
  });

  it("an asset of the OTHER entity does not get in the way", async () => {
    await db.asset.create({
      data: {
        entity: "welld_it",
        currency: "EUR",
        category: "laptop",
        description: "Italian laptop",
        purchaseDate: new Date("2026-01-05"),
        purchasePriceCents: 100_000,
        status: "in_stock",
        createdByUserId: "u-1",
      },
    });
    expect((await run()).code).toBe(0);
    expect(await db.asset.count({ where: { entity: "welld_it" } })).toBe(1);
    expect(await db.fiscalYear.count({ where: { entity: "welld_it" } })).toBe(0);
  });

  it("waits for the entity lock like every other dated write", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = db.$transaction(
      async (tx) => {
        await lockEntity(tx, "welld_ch");
        locked();
        await held;
      },
      { timeout: 20_000 },
    );
    await isLocked;
    let finished = false;
    const importing = run().then((r) => {
      finished = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(finished).toBe(false);
    expect((await counts()).assets).toBe(0);
    release();
    await holder;
    expect((await importing).code).toBe(0);
    expect((await counts()).assets).toBe(19);
  }, 30_000);
});

describe("all or nothing, and loud", () => {
  it("a failure after most rows were written leaves nothing behind", async () => {
    const parsed = parseSheet(toSheetRows(fixtureRows()));
    const plan = buildPlan({
      parsed,
      users: [...FIXTURE.users],
      ruleFor: () => ({ usefulLifeYears: 3, residualCents: 100 }),
    });
    // Two fiscal-year rows for 2025: the unique key trips at the very end of the write.
    const broken = { ...plan, fiscalYears: [plan.fiscalYears[0]!, plan.fiscalYears[1]!, plan.fiscalYears[1]!] };
    await expect(applyPlan(broken, FIXTURE.closing2025Cents)).rejects.toThrow();
    expect(await counts()).toEqual(NOTHING);
  });

  it("a row it cannot read is reported with its row number and stops the apply", async () => {
    await rewrite((rows) => void (rows.get(3)![0] = "31.02.2023"));
    for (const apply of [true, false]) {
      const r = await run({ apply });
      expect(r.code).toBe(1);
      expect(r.out.join("\n")).toContain("row 3 [bad_date]");
      expect(r.err.join("\n")).toContain("cannot be interpreted");
    }
    expect(await counts()).toEqual(NOTHING);
  });

  it("a repeated serial number stops it before the database does", async () => {
    await rewrite((rows) => void (rows.get(4)![2] = "SYN-A"));
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.out.join("\n")).toContain("[duplicate_serial]");
    expect(await counts()).toEqual(NOTHING);
  });

  it("is deterministic: two imports of the same file write the same figures", async () => {
    const snapshot = async () => {
      const assets = new Map((await db.asset.findMany()).map((a) => [a.id, a]));
      const figs = await db.assetYearFigure.findMany();
      return figs
        .map((f) => {
          const a = assets.get(f.assetId)!;
          return [a.description, a.purchasePriceCents, f.year, f.openingCents, f.depreciationCents, f.closingCents].join("|");
        })
        .sort();
    };
    await run();
    const first = await snapshot();
    await truncateInventoryTables();
    await run();
    expect(await snapshot()).toEqual(first);
  });

  it("refuses a missing file or user map as a usage error, writing nothing", async () => {
    expect((await run({ file: join(dir, "nope.xlsx") })).code).toBe(2);
    expect((await run({ userMapPath: join(dir, "nope.json") })).code).toBe(2);
    const bad = join(dir, "bad.json");
    await writeFile(bad, JSON.stringify([{ id: "x" }]));
    expect((await run({ userMapPath: bad })).code).toBe(2);
    await writeFile(bad, "not json");
    expect((await run({ userMapPath: bad })).code).toBe(2);
    expect(await counts()).toEqual(NOTHING);
  });

  it("an unreadable header stops everything", async () => {
    await rewrite((rows) => void rows.set(1, row({ A: "Date" })));
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.out.join("\n")).toContain("header_mismatch");
  });
});
