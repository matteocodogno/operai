/**
 * Schema-level guarantees of the initial migration (T2, specs/015-hardware-
 * inventory; AC-1.2, AC-1.5, AC-2.2, AC-6.5, AC-6.6, AC-8.7, AC-11.2;
 * ADR-0018/0024/0033/0046).
 *
 * Strategy
 * ────────
 * - Real Postgres (compose, `inventory` database) — no DB mocking. These tests
 *   exercise the migration's raw SQL, not application code: even a direct
 *   write that bypasses every route must be refused by the database.
 * - Cleanup uses TRUNCATE (via `truncateInventoryTables`), which does not fire
 *   the row-level BEFORE DELETE triggers, so it never fights the guarantee
 *   under test. It also puts the two launch rules back.
 * - `asPromise()`: Prisma 7 client methods return a lazy `PrismaPromise`
 *   (thenable, not `instanceof Promise`); `expect(...).rejects` needs a real
 *   Promise, so normalise first (same note as refund-api's immutability tests).
 *
 * The first describe block reads the launch rules BEFORE any cleanup has run in
 * this file. It cannot rule out an earlier file having truncated and re-seeded
 * from `dbCleanup.ts`'s copy of the values — that copy is compared against the
 * AC values here, which is the drift check; the migration text itself was
 * verified against a freshly migrated database when T2 was written.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { db } from "../lib/db";
import {
  LAUNCH_RULES,
  LAUNCH_RULE_ACTOR,
  truncateInventoryTables,
} from "./dbCleanup";

const asPromise = <T>(value: PromiseLike<T>): Promise<T> =>
  Promise.resolve(value);

type EntityName = "welld_ch" | "welld_it";

const CURRENCY: Record<EntityName, "CHF" | "EUR"> = {
  welld_ch: "CHF",
  welld_it: "EUR",
};

let serialCounter = 0;

async function makeAsset(
  overrides: Partial<{
    entity: EntityName;
    serialNumber: string | null;
    status: "ordered" | "in_stock" | "assigned" | "in_repair" | "lost" | "disposed";
    purchasePriceCents: number;
  }> = {},
) {
  const entity = overrides.entity ?? "welld_ch";
  return db.asset.create({
    data: {
      entity,
      currency: CURRENCY[entity],
      category: "laptop",
      description: "Test laptop",
      serialNumber:
        overrides.serialNumber === undefined
          ? `SN-${++serialCounter}`
          : overrides.serialNumber,
      purchaseDate: new Date("2026-03-01T00:00:00.000Z"),
      purchasePriceCents: overrides.purchasePriceCents ?? 99815,
      status: overrides.status ?? "in_stock",
      createdByUserId: "manager-1",
    },
  });
}

async function makeRule() {
  return db.depreciationRule.create({
    data: {
      entity: "welld_ch",
      effectiveFrom: new Date("2027-01-01T00:00:00.000Z"),
      usefulLifeYears: 4,
      firstYearShare: "full",
      lowValueThresholdCents: null,
      residualCents: 100,
      createdByUserId: "accountant-1",
      createdByEmail: "accountant@welld.ch",
    },
  });
}

async function makeFiscalYear() {
  return db.fiscalYear.create({
    data: {
      entity: "welld_ch",
      year: 2025,
      openingCents: 0,
      disposalsCents: 0,
      purchasesCents: 100000,
      depreciationCents: 33333,
      closingCents: 66667,
      source: "closed",
      closedByUserId: "accountant-1",
    },
  });
}

async function makeAssetYearFigure() {
  return db.assetYearFigure.create({
    data: {
      assetId: "asset-1",
      entity: "welld_ch",
      year: 2025,
      openingCents: 0,
      purchaseCents: 100000,
      depreciationCents: 33333,
      disposalCents: 0,
      closingCents: 66667,
      source: "closed",
    },
  });
}

async function makeAssetEvent() {
  return db.assetEvent.create({
    data: {
      assetId: "asset-1",
      entity: "welld_ch",
      action: "registered",
      actorUserId: "manager-1",
      actorEmail: "manager@welld.ch",
      oldValue: { status: null },
      newValue: { status: "in_stock" },
    },
  });
}

describe("launch depreciation rules (AC-6.6, AC-5.1, AC-5.4)", () => {
  it("has both rules, effective from 2000-01-01, with the values of AC-5.1 and AC-5.4", async () => {
    const rules = await db.depreciationRule.findMany({
      where: { createdByUserId: LAUNCH_RULE_ACTOR },
      orderBy: { entity: "asc" },
    });
    expect(rules).toHaveLength(2);

    const byEntity = Object.fromEntries(rules.map((r) => [r.entity, r]));
    const ch = byEntity["welld_ch"]!;
    const it = byEntity["welld_it"]!;

    // AC-5.1: 3 years, full first year, no threshold, residual CHF 1.00.
    expect(ch.usefulLifeYears).toBe(3);
    expect(ch.firstYearShare).toBe("full");
    expect(ch.lowValueThresholdCents).toBeNull();
    expect(ch.residualCents).toBe(100);

    // AC-5.4: 5 years, half first year, EUR 516.46 threshold, residual zero.
    expect(it.usefulLifeYears).toBe(5);
    expect(it.firstYearShare).toBe("half");
    expect(it.lowValueThresholdCents).toBe(51646);
    expect(it.residualCents).toBe(0);

    for (const rule of rules) {
      expect(rule.effectiveFrom.toISOString().slice(0, 10)).toBe("2000-01-01");
      expect(rule.createdByUserId).toBe(LAUNCH_RULE_ACTOR);
    }
  });

  it("is the same data dbCleanup restores after a truncate", async () => {
    await truncateInventoryTables();
    const rules = await db.depreciationRule.findMany({
      orderBy: { entity: "asc" },
    });
    expect(rules.map((r) => r.id).sort()).toEqual(
      LAUNCH_RULES.map((r) => r.id).sort(),
    );
    const ch = rules.find((r) => r.entity === "welld_ch")!;
    const it = rules.find((r) => r.entity === "welld_it")!;
    expect([ch.usefulLifeYears, ch.firstYearShare, ch.lowValueThresholdCents, ch.residualCents]).toEqual([3, "full", null, 100]);
    expect([it.usefulLifeYears, it.firstYearShare, it.lowValueThresholdCents, it.residualCents]).toEqual([5, "half", 51646, 0]);
  });
});

describe("append-only tables (AC-6.5, AC-8.7, AC-11.2; ADR-0018/0024/0046)", () => {
  beforeEach(async () => {
    await truncateInventoryTables();
  });

  afterAll(async () => {
    await truncateInventoryTables();
  });

  const cases: {
    table: string;
    make: () => Promise<{ id: string }>;
    column: string;
    // a value different from whatever `make` stored, valid for the column's type
    newValue: string | number;
    reread: (id: string) => Promise<Record<string, unknown> | null>;
    original: unknown;
  }[] = [
    {
      table: "depreciation_rule",
      make: makeRule,
      column: "residualCents",
      newValue: 1,
      reread: (id) => db.depreciationRule.findUnique({ where: { id } }),
      original: 100,
    },
    {
      table: "fiscal_year",
      make: makeFiscalYear,
      column: "closingCents",
      newValue: 1,
      reread: (id) => db.fiscalYear.findUnique({ where: { id } }),
      original: 66667,
    },
    {
      table: "asset_year_figure",
      make: makeAssetYearFigure,
      column: "closingCents",
      newValue: 1,
      reread: (id) => db.assetYearFigure.findUnique({ where: { id } }),
      original: 66667,
    },
    {
      table: "asset_event",
      make: makeAssetEvent,
      column: "actorEmail",
      newValue: "someone-else@welld.ch",
      reread: (id) => db.assetEvent.findUnique({ where: { id } }),
      original: "manager@welld.ch",
    },
  ];

  for (const c of cases) {
    it(`a raw UPDATE on ${c.table} raises and leaves the row untouched`, async () => {
      const row = await c.make();
      await expect(
        asPromise(
          db.$executeRawUnsafe(
            `UPDATE "${c.table}" SET "${c.column}" = $1 WHERE id = $2`,
            c.newValue,
            row.id,
          ),
        ),
      ).rejects.toThrow(/append-only/);

      // Prove the row is genuinely unchanged, not merely that the promise rejected.
      const after = await c.reread(row.id);
      expect(after?.[c.column]).toBe(c.original);
    });

    it(`a raw DELETE on ${c.table} raises and the row survives`, async () => {
      const row = await c.make();
      await expect(
        asPromise(
          db.$executeRawUnsafe(`DELETE FROM "${c.table}" WHERE id = $1`, row.id),
        ),
      ).rejects.toThrow(/append-only/);
      expect(await c.reread(row.id)).not.toBeNull();
    });

    it(`the Prisma client's own update and delete on ${c.table} are refused too`, async () => {
      const row = await c.make();
      const model = (db as unknown as Record<string, {
        update: (a: unknown) => PromiseLike<unknown>;
        delete: (a: unknown) => PromiseLike<unknown>;
      }>)[
        {
          depreciation_rule: "depreciationRule",
          fiscal_year: "fiscalYear",
          asset_year_figure: "assetYearFigure",
          asset_event: "assetEvent",
        }[c.table]!
      ]!;
      await expect(
        asPromise(
          model.update({ where: { id: row.id }, data: { [c.column]: c.newValue } }),
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        asPromise(model.delete({ where: { id: row.id } })),
      ).rejects.toThrow(/append-only/);
    });
  }

  it("(control) an INSERT into each append-only table still succeeds", async () => {
    await makeRule();
    await makeFiscalYear();
    await makeAssetYearFigure();
    await makeAssetEvent();
  });

  it("(AC-8.7) a second fiscal_year row for the same entity and year is rejected", async () => {
    await makeFiscalYear();
    await expect(asPromise(makeFiscalYear())).rejects.toThrow();
  });
});

describe("CHECK constraints (AC-1.2, AC-1.6, AC-6.4)", () => {
  beforeEach(async () => {
    await truncateInventoryTables();
  });

  afterAll(async () => {
    await truncateInventoryTables();
  });

  const insertAsset = (entity: string, currency: string, price: number) =>
    asPromise(
      db.$executeRawUnsafe(
        `INSERT INTO "asset" ("id","entity","currency","category","description","purchaseDate","purchasePriceCents","status","createdByUserId","updatedAt")
         VALUES ($1, $2::"Entity", $3::"Currency", 'laptop', 'x', DATE '2026-01-01', $4, 'in_stock', 'm', now())`,
        `chk-${entity}-${currency}-${price}`,
        entity,
        currency,
        price,
      ),
    );

  it("(AC-1.2) a welld_ch asset in EUR violates asset_currency_follows_entity", async () => {
    await expect(insertAsset("welld_ch", "EUR", 1000)).rejects.toThrow(
      /asset_currency_follows_entity|check constraint/i,
    );
  });

  it("(AC-1.2) a welld_it asset in CHF violates it too", async () => {
    await expect(insertAsset("welld_it", "CHF", 1000)).rejects.toThrow(
      /asset_currency_follows_entity|check constraint/i,
    );
  });

  it("(control) welld_ch/CHF and welld_it/EUR are accepted", async () => {
    await insertAsset("welld_ch", "CHF", 1000);
    await insertAsset("welld_it", "EUR", 1000);
  });

  it("(AC-1.6) a zero or negative price violates asset_price_positive", async () => {
    await expect(insertAsset("welld_ch", "CHF", 0)).rejects.toThrow(
      /asset_price_positive|check constraint/i,
    );
    await expect(insertAsset("welld_ch", "CHF", -5)).rejects.toThrow(
      /asset_price_positive|check constraint/i,
    );
  });

  const insertRule = (life: number, threshold: number | null, residual: number) =>
    asPromise(
      db.depreciationRule.create({
        data: {
          entity: "welld_ch",
          effectiveFrom: new Date("2030-01-01T00:00:00.000Z"),
          usefulLifeYears: life,
          firstYearShare: "full",
          lowValueThresholdCents: threshold,
          residualCents: residual,
          createdByUserId: "a",
          createdByEmail: "a@welld.ch",
        },
      }),
    );

  it("(AC-6.4) a rule with life < 1, a negative threshold or a negative residual is rejected", async () => {
    await expect(insertRule(0, null, 0)).rejects.toThrow(/depreciation_rule_life_min|check constraint/i);
    await expect(insertRule(3, -1, 0)).rejects.toThrow(/depreciation_rule_threshold_min|check constraint/i);
    await expect(insertRule(3, null, -1)).rejects.toThrow(/depreciation_rule_residual_min|check constraint/i);
  });

  it("(control) a rule with a null or zero threshold and zero residual is accepted", async () => {
    await insertRule(1, null, 0);
    await insertRule(1, 0, 0);
  });
});

describe("partial unique indexes (AC-1.4, AC-1.5, AC-2.2)", () => {
  beforeEach(async () => {
    await truncateInventoryTables();
  });

  afterAll(async () => {
    await truncateInventoryTables();
  });

  it("(AC-1.5) a second live asset with the same entity and serial is rejected", async () => {
    await makeAsset({ serialNumber: "DUP-1" });
    await expect(asPromise(makeAsset({ serialNumber: "DUP-1" }))).rejects.toThrow(
      /asset_serial_live|unique/i,
    );
  });

  it("(AC-1.5) the same serial is accepted once the first asset is disposed", async () => {
    const first = await makeAsset({ serialNumber: "DUP-2" });
    await db.asset.update({ where: { id: first.id }, data: { status: "disposed" } });
    await makeAsset({ serialNumber: "DUP-2" });
    expect(await db.asset.count({ where: { serialNumber: "DUP-2" } })).toBe(2);
  });

  it("(AC-1.5) a disposed asset does not block, and is not blocked by, another disposed one", async () => {
    await makeAsset({ serialNumber: "DUP-3", status: "disposed" });
    await makeAsset({ serialNumber: "DUP-3", status: "disposed" });
  });

  it("(AC-1.5) the same serial in the other entity is a different asset", async () => {
    await makeAsset({ entity: "welld_ch", serialNumber: "SHARED" });
    await makeAsset({ entity: "welld_it", serialNumber: "SHARED" });
  });

  it("(AC-1.4) any number of assets without a serial number is fine", async () => {
    await makeAsset({ serialNumber: null });
    await makeAsset({ serialNumber: null });
    await makeAsset({ serialNumber: null });
  });

  it("(AC-2.2) a second pending assignment on one asset is rejected", async () => {
    const asset = await makeAsset();
    await db.assignment.create({
      data: { assetId: asset.id, assigneeUserId: "u1", createdByUserId: "m" },
    });
    await expect(
      asPromise(
        db.assignment.create({
          data: { assetId: asset.id, assigneeUserId: "u2", createdByUserId: "m" },
        }),
      ),
    ).rejects.toThrow(/assignment_one_pending|unique/i);
  });

  it("(AC-2.2) once the pending one is resolved a new pending one is accepted, and other assets are independent", async () => {
    const asset = await makeAsset();
    const other = await makeAsset();
    const first = await db.assignment.create({
      data: { assetId: asset.id, assigneeUserId: "u1", createdByUserId: "m" },
    });
    await db.assignment.update({
      where: { id: first.id },
      data: { status: "cancelled", resolvedAt: new Date() },
    });
    await db.assignment.create({
      data: { assetId: asset.id, assigneeUserId: "u2", createdByUserId: "m" },
    });
    await db.assignment.create({
      data: { assetId: other.id, assigneeUserId: "u1", createdByUserId: "m" },
    });
  });

  it("(AC-2.2) two concurrent pending inserts on one asset: exactly one wins", async () => {
    const asset = await makeAsset();
    const attempt = (assignee: string) =>
      asPromise(
        db.assignment.create({
          data: { assetId: asset.id, assigneeUserId: assignee, createdByUserId: "m" },
        }),
      ).then(
        () => "ok" as const,
        () => "rejected" as const,
      );
    const results = await Promise.all([attempt("u1"), attempt("u2")]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "rejected")).toHaveLength(1);
  });
});
