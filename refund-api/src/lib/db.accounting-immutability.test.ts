/**
 * Accounting history tables: immutability, CHECKs and the fetched-once index
 * (T1, specs/20261118-refund-accounting-export; AC-1.5, AC-1.8, AC-2.1, AC-5.3,
 * AC-6.10; ADR 20260716-immutable-financial-audit-trail-refund).
 *
 * Strategy: real Postgres, no mocking. These tests exercise the raw SQL of the
 * `20261119090000_accounting_export` migration, not application code (there is
 * none yet). A raw UPDATE/DELETE must raise on each of the seven history
 * tables, and the row must be provably untouched afterwards. Cleanup uses
 * TRUNCATE (via `truncateRefundTables`), which does not fire row triggers.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { db } from "./db";
import { truncateRefundTables } from "../test-support/dbCleanup";

// Prisma 7 returns lazy PrismaPromises; `.rejects`/`.resolves` need a native one.
const asPromise = <T>(value: PromiseLike<T>): Promise<T> => Promise.resolve(value);

const actor = { createdByUserId: "admin-1", createdByEmail: "admin@welld.ch" };

let seq = 0;
async function makeAccount(number = `59${String(10 + seq++).padStart(2, "0")}`) {
  return db.ledgerAccount.create({
    data: { entity: "welld_ch", number, name: "Spese rimborsi chilometrici", ...actor },
  });
}

async function makeVatCode(code = `C${seq++}`, rateBasisPoints = 810) {
  return db.vatCode.create({
    data: { entity: "welld_ch", code, label: "IVA 8.1%", rateBasisPoints, ...actor },
  });
}

async function makeBatch() {
  return db.refundBatch.create({
    data: {
      cutoff: new Date("2026-11-01T00:00:00.000Z"),
      createdByUserId: "acct-1",
      createdByEmail: "acct-1@welld.ch",
      pdfObjectKey: `refund/batches/${crypto.randomUUID()}/compiled.pdf`,
    },
  });
}

function makeRate(overrides: Record<string, unknown> = {}) {
  return db.exchangeRateEntry.create({
    data: {
      currency: "EUR",
      month: new Date("2026-03-01"),
      rateMicros: 924600,
      origin: "fetched",
      sourceUrl: "https://www.backend-rates.bazg.admin.ch/api/xmlavgmonth?j=2026&m=03",
      sourceMonth: "2026-03",
      fetchedAt: new Date(),
      createdByUserId: "system:fx-fetch",
      createdByEmail: "system-fx-fetch@welld.ch",
      ...overrides,
    },
  });
}

/** One factory per history table: returns the new row's id. */
const factories: Record<string, () => Promise<{ id: string }>> = {
  ledger_account: () => makeAccount(),
  vat_code: () => makeVatCode(),
  accounting_catalog_status: async () => {
    const account = await makeAccount();
    return db.accountingCatalogStatus.create({
      data: { ledgerAccountId: account.id, active: false, ...actor },
    });
  },
  expense_type_default: async () => {
    const account = await makeAccount();
    return db.expenseTypeDefault.create({
      data: { entity: "welld_ch", type: "travel_km", ledgerAccountId: account.id, ...actor },
    });
  },
  exchange_rate_entry: () => makeRate(),
  exchange_rate_fetch_attempt: () =>
    db.exchangeRateFetchAttempt.create({
      data: {
        month: new Date("2026-03-01"),
        trigger: "admin",
        outcome: "ok",
        recorded: { EUR: 924600 },
        actorUserId: "admin-1",
      },
    }),
  refund_batch_export: async () => {
    const batch = await makeBatch();
    return db.refundBatchExport.create({
      data: {
        batchId: batch.id,
        actorUserId: "acct-1",
        actorEmail: "acct-1@welld.ch",
        rowCount: 3,
        excludedLineCount: 0,
        contentSha256: "a".repeat(64),
        formatVersion: 1,
      },
    });
  },
};

// A column that exists on every table, to give the UPDATE something to change.
const touchedColumn: Record<string, string> = {
  ledger_account: '"name"',
  vat_code: '"label"',
  accounting_catalog_status: '"active"',
  expense_type_default: '"createdByEmail"',
  exchange_rate_entry: '"rateMicros"',
  exchange_rate_fetch_attempt: '"outcome"',
  refund_batch_export: '"rowCount"',
};
const touchedValue: Record<string, unknown> = {
  ledger_account: "changed",
  vat_code: "changed",
  accounting_catalog_status: true,
  expense_type_default: "changed@welld.ch",
  exchange_rate_entry: 1,
  exchange_rate_fetch_attempt: "failed",
  refund_batch_export: 99,
};

describe("accounting history tables are append-only at the database (AC-1.8, AC-2.1, AC-5.3, AC-6.10)", () => {
  beforeEach(async () => {
    await truncateRefundTables();
  });
  afterAll(async () => {
    await truncateRefundTables();
  });

  for (const table of Object.keys(factories)) {
    it(`${table}: a raw UPDATE raises and leaves the row untouched`, async () => {
      const row = await factories[table]!();
      const before = await db.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT * FROM "${table}" WHERE id = $1`,
        row.id,
      );

      await expect(
        asPromise(
          db.$executeRawUnsafe(
            `UPDATE "${table}" SET ${touchedColumn[table]} = $1 WHERE id = $2`,
            touchedValue[table],
            row.id,
          ),
        ),
      ).rejects.toThrow(/append-only/);

      const after = await db.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT * FROM "${table}" WHERE id = $1`,
        row.id,
      );
      expect(after).toEqual(before);
    });

    it(`${table}: a raw DELETE raises and the row survives`, async () => {
      const row = await factories[table]!();

      await expect(
        asPromise(db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE id = $1`, row.id)),
      ).rejects.toThrow(/append-only/);

      const rows = await db.$queryRawUnsafe<unknown[]>(
        `SELECT 1 FROM "${table}" WHERE id = $1`,
        row.id,
      );
      expect(rows).toHaveLength(1);
    });
  }

  it("(AC-1.5) vat_code.rateBasisPoints cannot be updated, by SQL or by the Prisma client", async () => {
    const vat = await makeVatCode("IMP81", 810);

    await expect(
      asPromise(
        db.$executeRawUnsafe(`UPDATE "vat_code" SET "rateBasisPoints" = 770 WHERE id = $1`, vat.id),
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      asPromise(db.vatCode.update({ where: { id: vat.id }, data: { rateBasisPoints: 770 } })),
    ).rejects.toThrow();

    expect((await db.vatCode.findUniqueOrThrow({ where: { id: vat.id } })).rateBasisPoints).toBe(810);
  });

  it("(control) appending to every history table still works", async () => {
    for (const table of Object.keys(factories)) {
      await expect(asPromise(factories[table]!())).resolves.toBeTruthy();
    }
    // A catalog status row appended after another is the normal reactivation path.
    const account = await makeAccount("6101");
    await db.accountingCatalogStatus.create({ data: { ledgerAccountId: account.id, active: false, ...actor } });
    await db.accountingCatalogStatus.create({ data: { ledgerAccountId: account.id, active: true, ...actor } });
    expect(await db.accountingCatalogStatus.count({ where: { ledgerAccountId: account.id } })).toBe(2);
  });
});

describe("accounting CHECK constraints and unique indexes (AC-1.2, AC-1.4, AC-1.5, AC-5.3)", () => {
  beforeEach(async () => {
    await truncateRefundTables();
  });
  afterAll(async () => {
    await truncateRefundTables();
  });

  it("vat_code.rateBasisPoints is limited to 0..10000", async () => {
    await expect(asPromise(makeVatCode("ZERO", 0))).resolves.toBeTruthy();
    await expect(asPromise(makeVatCode("FULL", 10000))).resolves.toBeTruthy();
    await expect(asPromise(makeVatCode("NEG", -1))).rejects.toThrow();
    await expect(asPromise(makeVatCode("OVER", 10001))).rejects.toThrow();
  });

  it("a ledger account number is unique per entity, and so is a VAT code (backstops of AC-1.2, AC-1.4)", async () => {
    await makeAccount("5905");
    await expect(asPromise(makeAccount("5905"))).rejects.toThrow();
    await makeVatCode("IMP81");
    await expect(asPromise(makeVatCode("IMP81"))).rejects.toThrow();
    // Same number in the other entity is a different account.
    await expect(
      asPromise(
        db.ledgerAccount.create({ data: { entity: "welld_it", number: "5905", name: "x", ...actor } }),
      ),
    ).resolves.toBeTruthy();
  });

  it("an accounting_catalog_status row names exactly one of account / VAT code", async () => {
    const account = await makeAccount();
    const vat = await makeVatCode();
    await expect(
      asPromise(db.accountingCatalogStatus.create({ data: { active: false, ...actor } })),
    ).rejects.toThrow();
    await expect(
      asPromise(
        db.accountingCatalogStatus.create({
          data: { ledgerAccountId: account.id, vatCodeId: vat.id, active: false, ...actor },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      asPromise(db.accountingCatalogStatus.create({ data: { vatCodeId: vat.id, active: false, ...actor } })),
    ).resolves.toBeTruthy();
  });

  it("exchange_rate_entry refuses CHF, a rate of 0 or less, and a month that is not the first day", async () => {
    await expect(asPromise(makeRate({ currency: "CHF" }))).rejects.toThrow();
    await expect(asPromise(makeRate({ rateMicros: 0 }))).rejects.toThrow();
    await expect(asPromise(makeRate({ rateMicros: -5 }))).rejects.toThrow();
    await expect(asPromise(makeRate({ month: new Date("2026-03-15") }))).rejects.toThrow();
    await expect(asPromise(makeRate({ currency: "USD", month: new Date("2026-04-01") }))).resolves.toBeTruthy();
  });

  it("(extra test) a second fetched row for the same (currency, month) is refused; a second corrected row is accepted", async () => {
    await makeRate();
    await expect(asPromise(makeRate({ rateMicros: 925000 }))).rejects.toThrow(/exchange_rate_fetched_once|unique/i);

    // Another currency, or another month, is a different key.
    await expect(asPromise(makeRate({ currency: "USD" }))).resolves.toBeTruthy();
    await expect(asPromise(makeRate({ month: new Date("2026-04-01") }))).resolves.toBeTruthy();

    // Corrections are append-only and unlimited.
    const corrected = { origin: "corrected", sourceUrl: null, sourceMonth: null, fetchedAt: null, createdByUserId: "admin-1", createdByEmail: "admin@welld.ch" };
    await expect(asPromise(makeRate({ ...corrected, rateMicros: 930000 }))).resolves.toBeTruthy();
    await expect(asPromise(makeRate({ ...corrected, rateMicros: 931000 }))).resolves.toBeTruthy();
    expect(await db.exchangeRateEntry.count({ where: { currency: "EUR", month: new Date("2026-03-01") } })).toBe(3);
  });

  it("the fetched-once index is partial: it holds on origin = 'fetched' only", async () => {
    const rows = await db.$queryRawUnsafe<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'exchange_rate_fetched_once'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toMatch(/UNIQUE/);
    expect(rows[0]!.indexdef).toMatch(/WHERE/);
  });

  it("every new foreign key is ON DELETE RESTRICT (a referenced account, VAT code or batch is physically undeletable)", async () => {
    // The immutability triggers raise first; the FKs are the second wall.
    const rows = await db.$queryRawUnsafe<{ confdeltype: string; conname: string }[]>(
      `SELECT conname::text AS conname, confdeltype::text AS confdeltype FROM pg_constraint
       WHERE conname IN ('refund_line_ledgerAccountId_fkey','refund_line_vatCodeId_fkey',
                         'expense_type_default_ledgerAccountId_fkey','expense_type_default_vatCodeId_fkey',
                         'accounting_catalog_status_ledgerAccountId_fkey','accounting_catalog_status_vatCodeId_fkey',
                         'refund_batch_export_batchId_fkey')`,
    );
    expect(rows).toHaveLength(7);
    // 'r' = RESTRICT
    expect(rows.every((r) => r.confdeltype === "r")).toBe(true);
  });
});
