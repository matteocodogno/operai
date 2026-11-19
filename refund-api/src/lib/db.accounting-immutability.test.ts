/**
 * Accounting history tables that stay in refund-api: immutability and the
 * constraints around them (T1, specs/20261118-refund-accounting-export, AC-6.10;
 * T24, specs/20261119-accounting; ADR 20260716-immutable-financial-audit-trail-refund).
 *
 * Strategy: real Postgres, no mocking. These tests exercise the raw SQL of the
 * `20261119090000_accounting_export` and `20261119120000_accounting_copies`
 * migrations, not application code. A raw UPDATE/DELETE must raise on each of
 * the three history tables that remain (the export log and the two tables of
 * copies: the defaults and the foreign-currency VAT designation), and the row
 * must be provably untouched afterwards. Cleanup uses TRUNCATE (via
 * `truncateRefundTables`), which does not fire row triggers.
 *
 * The catalog, its status history, the rates and their attempt log moved to
 * accounting-api (their counterparts are in accounting-api's db.*.test.ts);
 * `20261119130000_accounting_reference_moved_out` dropped them here, and the
 * last test below proves they are gone.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { db } from "./db";
import { truncateRefundTables } from "../test-support/dbCleanup";

// Prisma 7 returns lazy PrismaPromises; `.rejects`/`.resolves` need a native one.
const asPromise = <T>(value: PromiseLike<T>): Promise<T> => Promise.resolve(value);

const actor = { createdByUserId: "admin-1", createdByEmail: "admin@welld.ch" };

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

/** One factory per history table: returns the new row's id. */
const factories: Record<string, () => Promise<{ id: string }>> = {
  expense_type_accounting_default: () =>
    db.expenseTypeAccountingDefault.create({
      data: {
        entity: "welld_ch",
        type: "travel_km",
        accountNumber: "5901",
        accountName: "Spese rimborsi chilometrici",
        vatCode: "IMP81",
        vatLabel: "IVA 8.1%",
        vatRateBasisPoints: 810,
        ...actor,
      },
    }),
  foreign_currency_vat_designation: () =>
    db.foreignCurrencyVatDesignation.create({
      data: { entity: "welld_ch", vatCode: "NOVAT", vatLabel: "Senza IVA", vatRateBasisPoints: 0, ...actor },
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
  expense_type_accounting_default: '"createdByEmail"',
  foreign_currency_vat_designation: '"createdByEmail"',
  refund_batch_export: '"rowCount"',
};
const touchedValue: Record<string, unknown> = {
  expense_type_accounting_default: "changed@welld.ch",
  foreign_currency_vat_designation: "changed@welld.ch",
  refund_batch_export: 99,
};

describe("the accounting history tables of refund-api are append-only at the database (AC-6.10, AC-5.7)", () => {
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

  it("(control) appending to every history table still works, and a second row of the same key is a new row", async () => {
    for (const table of Object.keys(factories)) {
      await expect(asPromise(factories[table]!())).resolves.toBeTruthy();
    }
    await factories["expense_type_accounting_default"]!();
    expect(await db.expenseTypeAccountingDefault.count()).toBe(2);
  });
});

describe("what stays, and what the move dropped (T24)", () => {
  afterAll(async () => {
    await truncateRefundTables();
  });

  it("the export log's foreign key to the batch is ON DELETE RESTRICT (a batch with an export is physically undeletable)", async () => {
    // The immutability triggers raise first; the FK is the second wall.
    const rows = await db.$queryRawUnsafe<{ confdeltype: string; conname: string }[]>(
      `SELECT conname::text AS conname, confdeltype::text AS confdeltype FROM pg_constraint
       WHERE conname IN ('refund_batch_export_batchId_fkey')`,
    );
    expect(rows).toHaveLength(1);
    // 'r' = RESTRICT
    expect(rows.every((r) => r.confdeltype === "r")).toBe(true);
  });

  it("the six moved tables, the two old FK columns, the enum of the rates and their index are gone; what the rest uses stays", async () => {
    const tables = (
      await db.$queryRawUnsafe<{ tablename: string }[]>(`SELECT tablename::text AS tablename FROM pg_tables WHERE schemaname = 'public'`)
    ).map((t) => t.tablename);
    for (const gone of [
      "ledger_account",
      "vat_code",
      "accounting_catalog_status",
      "expense_type_default",
      "exchange_rate_entry",
      "exchange_rate_fetch_attempt",
    ]) {
      expect(tables).not.toContain(gone);
    }
    for (const kept of ["refund_batch_export", "receipt_counter", "expense_type_accounting_default", "foreign_currency_vat_designation"]) {
      expect(tables).toContain(kept);
    }
    const columns = (
      await db.$queryRawUnsafe<{ column_name: string }[]>(
        `SELECT column_name::text AS column_name FROM information_schema.columns WHERE table_name = 'refund_line'`,
      )
    ).map((c) => c.column_name);
    expect(columns).not.toContain("ledgerAccountId");
    expect(columns).not.toContain("vatCodeId");
    expect(columns).toEqual(expect.arrayContaining(["ledgerAccountIsDefault", "vatCodeIsDefault", "accountNumber", "vatCode"]));
    const enumCount = (await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM pg_type WHERE typname = 'ExchangeRateOrigin'`))[0]!.n;
    expect(enumCount).toBe(0);
    const indexCount = (await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'exchange_rate_fetched_once'`))[0]!.n;
    expect(indexCount).toBe(0);
    // the raising function is still there: the three tables above use it
    const fnCount = (await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'accounting_history_immutable'`))[0]!.n;
    expect(fnCount).toBe(1);
  });
});
