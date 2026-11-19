/**
 * The three additive migrations of the accounting sign-off round, on the test database
 * (T58, specs/20261119-accounting; plan 20261118 § "Accounting sign-off delta (2026-11-19)",
 * SO-1, SO-13; plan 20261119 SO-18; AC-8.1, AC-4.12, AC-4.7, AC-4.5):
 *   - `20261119200000_expense_types_flight_taxi`
 *   - `20261119200100_receipt_number_baseline`
 *   - `20261119200200_vat_defaults_retired`
 *
 * Real Postgres, raw SQL where the trigger or the CHECK is the subject, no application code
 * (none reads the baseline yet: T63). The migrations on data (a database brought to
 * 20261119130000 with rows) are in `migration.accounting-signoff.test.ts`. Cleanup uses
 * TRUNCATE, which does not fire row triggers.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { db } from "./db";
import { truncateRefundTables } from "../test-support/dbCleanup";

// Prisma 7 returns lazy PrismaPromises; `.rejects`/`.resolves` need a native one.
const asPromise = <T>(value: PromiseLike<T>): Promise<T> => Promise.resolve(value);

const actor = { createdByUserId: "system:accounting-release", createdByEmail: "accounting-release@welld.ch" };

type Row = Record<string, any>;
const query = (text: string, ...values: unknown[]) => asPromise(db.$queryRawUnsafe<Row[]>(text, ...values));

describe("receipt_number_baseline: append-only, 2026 only (AC-4.12, AC-4.11)", () => {
  beforeEach(async () => {
    await truncateRefundTables();
  });
  afterAll(async () => {
    await truncateRefundTables();
  });

  const valid = { emailKey: "matteo.codogno@welld.ch", year: 2026, lastIssuedSeq: 81, ...actor };
  const insert = (over: Partial<typeof valid> = {}) => asPromise(db.receiptNumberBaseline.create({ data: { ...valid, ...over } }));

  it("(control) a 2026 row is accepted, at both boundaries of the sequence", async () => {
    const row = await insert();
    expect(row).toMatchObject({ emailKey: "matteo.codogno@welld.ch", year: 2026, lastIssuedSeq: 81 });
    expect(row.id.length).toBeGreaterThan(10);
    expect(row.createdAt).toBeInstanceOf(Date);
    await expect(insert({ emailKey: "a@welld.ch", lastIssuedSeq: 1 })).resolves.toBeTruthy();
    await expect(insert({ emailKey: "b@welld.ch", lastIssuedSeq: 99999 })).resolves.toBeTruthy();
  });

  it("refuses a 2025 row, a 2027 row and every other year (AC-4.12: no other year is continued)", async () => {
    for (const year of [2025, 2027, 2000, 2026 - 1, 0]) {
      await expect(insert({ year })).rejects.toThrow(/receipt_number_baseline_year_2026/);
    }
    // raw SQL takes the same road
    await expect(
      query(
        `INSERT INTO "receipt_number_baseline" ("id", "emailKey", "year", "lastIssuedSeq", "createdByUserId", "createdByEmail")
         VALUES ('raw-2025', 'x@welld.ch', 2025, 5, 'u', 'u@welld.ch')`,
      ),
    ).rejects.toThrow(/receipt_number_baseline_year_2026/);
    expect(await db.receiptNumberBaseline.count()).toBe(0);
  });

  it("refuses a sequence outside 1..99999", async () => {
    for (const lastIssuedSeq of [0, -1, 100000, 2147483647]) {
      await expect(insert({ lastIssuedSeq })).rejects.toThrow(/receipt_number_baseline_seq_range/);
    }
    expect(await db.receiptNumberBaseline.count()).toBe(0);
  });

  it("refuses an email key that is not lower-case or has no '@' (AC-4.11: the key is the lower-cased email)", async () => {
    for (const emailKey of ["Matteo.Codogno@welld.ch", "MATTEO@WELLD.CH", "m@Welld.ch"]) {
      await expect(insert({ emailKey })).rejects.toThrow(/receipt_number_baseline_email_key_lower/);
    }
    for (const emailKey of ["matteo", "", "no-at-sign.welld.ch"]) {
      await expect(insert({ emailKey })).rejects.toThrow(/receipt_number_baseline_email_key_lower/);
    }
    expect(await db.receiptNumberBaseline.count()).toBe(0);
  });

  it("an UPDATE of a baseline row raises, column by column, and the row is untouched", async () => {
    const row = await insert();
    for (const assignment of [`"lastIssuedSeq" = 82`, `"emailKey" = 'other@welld.ch'`, `"year" = 2026`, `"createdByEmail" = 'x@welld.ch'`]) {
      await expect(query(`UPDATE "receipt_number_baseline" SET ${assignment} WHERE id = $1`, row.id)).rejects.toThrow(/append-only/);
    }
    await expect(asPromise(db.receiptNumberBaseline.update({ where: { id: row.id }, data: { lastIssuedSeq: 90 } }))).rejects.toThrow();
    await expect(query(`UPDATE "receipt_number_baseline" SET "lastIssuedSeq" = 82`)).rejects.toThrow(/append-only/); // even a no-key UPDATE
    const reread = await db.receiptNumberBaseline.findUniqueOrThrow({ where: { id: row.id } });
    expect(reread).toEqual(row);
  });

  it("a DELETE of a baseline row raises and the row stays", async () => {
    const row = await insert();
    await expect(query(`DELETE FROM "receipt_number_baseline" WHERE id = $1`, row.id)).rejects.toThrow(/append-only/);
    await expect(asPromise(db.receiptNumberBaseline.delete({ where: { id: row.id } }))).rejects.toThrow();
    await expect(asPromise(db.receiptNumberBaseline.deleteMany())).rejects.toThrow();
    expect(await db.receiptNumberBaseline.count()).toBe(1);
  });

  it("is append-only, not unique: a later row for the same email and year is the current value (latest createdAt)", async () => {
    await insert({ lastIssuedSeq: 81 });
    await new Promise((r) => setTimeout(r, 5));
    await insert({ lastIssuedSeq: 90 });
    const latest = await db.receiptNumberBaseline.findFirstOrThrow({
      where: { emailKey: "matteo.codogno@welld.ch", year: 2026 },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    expect(latest.lastIssuedSeq).toBe(90);
    expect(await db.receiptNumberBaseline.count()).toBe(2);
  });

  it("TRUNCATE (test cleanup) is not blocked by the triggers", async () => {
    await insert();
    await truncateRefundTables();
    expect(await db.receiptNumberBaseline.count()).toBe(0);
  });

  it("has the lookup index and both triggers, and uses the shared raising function", async () => {
    const idx = await query(`SELECT indexdef FROM pg_indexes WHERE tablename = 'receipt_number_baseline' AND indexname <> 'receipt_number_baseline_pkey'`);
    expect(idx.map((r) => r["indexdef"])).toEqual([
      expect.stringMatching(/\("emailKey", year, "createdAt"\)/),
    ]);
    const triggers = await query(
      `SELECT t.tgname, p.proname, (t.tgtype & 2) <> 0 AS before_row_trigger, (t.tgtype & 1) <> 0 AS per_row, t.tgtype & 8 <> 0 AS on_delete, t.tgtype & 16 <> 0 AS on_update
       FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE t.tgrelid = 'receipt_number_baseline'::regclass AND NOT t.tgisinternal ORDER BY t.tgname`,
    );
    expect(triggers).toEqual([
      { tgname: "receipt_number_baseline_no_delete", proname: "accounting_history_immutable", before_row_trigger: true, per_row: true, on_delete: true, on_update: false },
      { tgname: "receipt_number_baseline_no_update", proname: "accounting_history_immutable", before_row_trigger: true, per_row: true, on_delete: false, on_update: true },
    ]);
  });
});

describe("ExpenseType: travel_flight and travel_taxi (AC-8.1)", () => {
  beforeEach(async () => {
    await truncateRefundTables();
  });
  afterAll(async () => {
    await truncateRefundTables();
  });

  it("the enum reads, in order, ... travel_other_public_transport, travel_flight, travel_taxi, company_manuals ...", async () => {
    const rows = await query(`SELECT enumlabel FROM pg_enum WHERE enumtypid = '"ExpenseType"'::regtype ORDER BY enumsortorder`);
    expect(rows.map((r) => r["enumlabel"])).toEqual([
      "travel_highway",
      "travel_km",
      "travel_parking",
      "travel_train",
      "travel_other_public_transport",
      "travel_flight",
      "travel_taxi",
      "company_manuals",
      "stationery",
      "representation_meals",
      "representation_gifts",
      "office_material",
      "postal",
      "telephone",
    ]);
  });

  it("a line of each new type can be stored, for both entities, and read back", async () => {
    const request = await db.refundRequest.create({ data: { ownerUserId: "owner-1", ownerEmail: "owner-1@welld.ch", status: "draft" } });
    for (const type of ["travel_flight", "travel_taxi"] as const) {
      for (const entity of ["welld_ch", "welld_it"] as const) {
        const line = await db.refundLine.create({
          data: { requestId: request.id, date: new Date("2026-03-02"), type, motivo: "m", entity, currency: "CHF", requestedAmountCents: 1000 },
        });
        expect((await db.refundLine.findUniqueOrThrow({ where: { id: line.id } })).type).toBe(type);
      }
    }
  });

  it("a default row can name each new type", async () => {
    const flight = await db.expenseTypeAccountingDefault.create({
      data: { entity: "welld_ch", type: "travel_flight", accountNumber: "5902", accountName: "Spese viaggi in aereo", ...actor },
    });
    const taxi = await db.expenseTypeAccountingDefault.create({
      data: { entity: "welld_ch", type: "travel_taxi", accountNumber: "5903", accountName: "Spese viaggi taxi", ...actor },
    });
    expect([flight.type, taxi.type]).toEqual(["travel_flight", "travel_taxi"]);
  });
});

describe("the VAT half of the defaults and the designation table are gone (SO-18; AC-4.5, AC-4.7)", () => {
  it("foreign_currency_vat_designation no longer exists, with its triggers", async () => {
    expect(await query(`SELECT to_regclass('public.foreign_currency_vat_designation')::text AS t`)).toEqual([{ t: null }]);
    expect(await query(`SELECT tgname FROM pg_trigger WHERE tgname LIKE 'foreign_currency_vat_designation%'`)).toEqual([]);
    // the shared function the other history tables use is still there
    expect(await query(`SELECT proname FROM pg_proc WHERE proname = 'accounting_history_immutable'`)).toHaveLength(1);
  });

  it("expense_type_accounting_default keeps exactly its account half, with its two remaining CHECKs", async () => {
    const cols = await query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'expense_type_accounting_default' ORDER BY column_name`,
    );
    expect(cols.map((c) => c["column_name"])).toEqual(
      ["accountName", "accountNumber", "createdAt", "createdByEmail", "createdByUserId", "entity", "id", "type"].sort(),
    );
    const checks = await query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'expense_type_accounting_default'::regclass AND contype = 'c' ORDER BY conname`,
    );
    expect(checks.map((c) => c["conname"])).toEqual([
      "expense_type_accounting_default_account_pair",
      "expense_type_accounting_default_ch_only",
    ]);
  });

  it("the defaults table stays append-only and keeps its two CHECKs in force", async () => {
    await truncateRefundTables();
    const row = await db.expenseTypeAccountingDefault.create({
      data: { entity: "welld_ch", type: "travel_km", accountNumber: "5905", accountName: "Spese rimborsi chilometrici", ...actor },
    });
    await expect(query(`UPDATE "expense_type_accounting_default" SET "accountNumber" = '1' WHERE id = $1`, row.id)).rejects.toThrow(/append-only/);
    await expect(query(`DELETE FROM "expense_type_accounting_default" WHERE id = $1`, row.id)).rejects.toThrow(/append-only/);
    await expect(
      asPromise(db.expenseTypeAccountingDefault.create({ data: { entity: "welld_it", type: "travel_km", ...actor } })),
    ).rejects.toThrow(/expense_type_accounting_default_ch_only/);
    await expect(
      asPromise(db.expenseTypeAccountingDefault.create({ data: { entity: "welld_ch", type: "travel_km", accountNumber: "5905", ...actor } })),
    ).rejects.toThrow(/expense_type_accounting_default_account_pair/);
    // a "no default" row (both halves null) is still the way to clear a default
    await expect(
      asPromise(db.expenseTypeAccountingDefault.create({ data: { entity: "welld_ch", type: "travel_km", ...actor } })),
    ).resolves.toBeTruthy();
    await truncateRefundTables();
  });

  it("the line copies keep their VAT columns and the guard that locks them (the lines are out of this migration's scope)", async () => {
    const cols = await query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'refund_line'
         AND column_name IN ('vatCode', 'vatRateBasisPoints', 'vatCodeIsDefault') ORDER BY column_name`,
    );
    expect(cols.map((c) => c["column_name"])).toEqual(["vatCode", "vatCodeIsDefault", "vatRateBasisPoints"]);
    expect(await query(`SELECT 1 FROM pg_constraint WHERE conname IN ('refund_line_vat_copy_pair', 'refund_line_vat_rate_range')`)).toHaveLength(2);
  });
});
