/**
 * The copy columns of `refund_line`, the two append-only tables of copies, the
 * CHECKs and the exchange-rate write-once rule of guard v2 (T16,
 * specs/20261119-accounting; AC-4.7, AC-5.3, AC-5.6, AC-5.7, AC-7.1; ADR
 * 20261119-accounting-reference-data-belongs-to-accounting-api-...).
 *
 * Real Postgres, raw SQL where the trigger or the constraint is the subject, no
 * application code (there is none yet on the copies). The paid lock of the
 * classification copies is in `db.accounting-receipt-guard.test.ts`. Cleanup
 * uses TRUNCATE, which does not fire row triggers.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { db } from "./db";
import { truncateRefundTables } from "../test-support/dbCleanup";

// Prisma 7 returns lazy PrismaPromises; `.rejects`/`.resolves` need a native one.
const asPromise = <T>(value: PromiseLike<T>): Promise<T> => Promise.resolve(value);

const actor = { createdByUserId: "admin-1", createdByEmail: "admin@welld.ch" };

type Status = "draft" | "submitted" | "approved" | "paid";

interface LineOpts {
  status?: Status;
  entity?: "welld_ch" | "welld_it";
  currency?: "CHF" | "EUR" | "USD" | "GBP";
  date?: string;
  numbered?: boolean;
  fx?: boolean;
}

let owner = 0;
async function line(opts: LineOpts = {}) {
  const ownerId = `owner-${++owner}`;
  const request = await db.refundRequest.create({
    data: { ownerUserId: ownerId, ownerEmail: `${ownerId}@welld.ch`, status: opts.status ?? "approved" },
  });
  const created = await db.refundLine.create({
    data: {
      requestId: request.id,
      date: new Date(opts.date ?? "2026-03-02"),
      type: "office_material",
      motivo: "Paper",
      entity: opts.entity ?? "welld_ch",
      currency: opts.currency ?? "EUR",
      requestedAmountCents: 1000,
      approvedTotalCents: 1000,
      ...(opts.numbered === false
        ? {}
        : { receiptNumber: "MC26/001", receiptOwnerUserId: ownerId, receiptYear: 2026, receiptSeq: 1, numberedAt: new Date() }),
      ...(opts.fx
        ? { fxRateMicros: 924600, fxRateMonth: new Date("2026-03-01"), fxRateCopiedAt: new Date("2026-04-01T10:00:00Z") }
        : {}),
    },
  });
  return { request, line: created };
}

const rawUpdate = (id: string, assignments: string, ...values: unknown[]) =>
  asPromise(db.$executeRawUnsafe(`UPDATE "refund_line" SET ${assignments} WHERE id = $${values.length + 1}`, ...values, id));

describe("refund_line_accounting_guard v2: the exchange-rate copy is write-once (AC-5.3, AC-5.6, AC-5.7)", () => {
  beforeEach(async () => {
    await truncateRefundTables();
  });
  afterAll(async () => {
    await truncateRefundTables();
  });

  const SET = `"fxRateMicros" = 924600, "fxRateMonth" = '2026-03-01', "fxRateCopiedAt" = '2026-04-01 10:00:00'`;

  for (const status of ["draft", "submitted", "approved", "paid"] as const) {
    it(`null -> set is allowed on a ${status} request's line (approval, or the pending copy at export)`, async () => {
      const f = await line({ status });
      await expect(rawUpdate(f.line.id, SET)).resolves.toBe(1);
      const reread = await db.refundLine.findUniqueOrThrow({ where: { id: f.line.id } });
      expect(reread.fxRateMicros).toBe(924600);
      expect(reread.fxRateMonth?.toISOString().slice(0, 10)).toBe("2026-03-01");
      expect(reread.fxRateCopiedAt?.toISOString()).toBe("2026-04-01T10:00:00.000Z");
    });

    it(`set -> changed is refused on a ${status} request's line, one column at a time and cleared`, async () => {
      const f = await line({ status, fx: true });
      const attempts: [string, unknown[]][] = [
        [`"fxRateMicros" = 930000`, []],
        [`"fxRateMonth" = '2026-03-01', "fxRateCopiedAt" = '2026-05-01 00:00:00'`, []],
        [`"fxRateCopiedAt" = '2026-05-01 00:00:00'`, []],
        [`"fxRateMicros" = NULL, "fxRateMonth" = NULL, "fxRateCopiedAt" = NULL`, []],
      ];
      for (const [assignments, values] of attempts) {
        await expect(rawUpdate(f.line.id, assignments, ...values)).rejects.toThrow(/write-once/);
      }
      await expect(
        asPromise(db.refundLine.update({ where: { id: f.line.id }, data: { fxRateMicros: 1 } })),
      ).rejects.toThrow();
      const reread = await db.refundLine.findUniqueOrThrow({ where: { id: f.line.id } });
      expect(reread.fxRateMicros).toBe(924600);
      expect(reread.fxRateCopiedAt?.toISOString()).toBe("2026-04-01T10:00:00.000Z");
    });
  }

  it("a paid, numbered line that is still rate pending gets its copy at the first export (null -> set), then never again", async () => {
    const f = await line({ status: "paid" });
    await expect(rawUpdate(f.line.id, SET)).resolves.toBe(1);
    await expect(rawUpdate(f.line.id, `"fxRateMicros" = 924601`)).rejects.toThrow(/write-once/);
  });

  it("writing the same values again is not a change", async () => {
    const f = await line({ status: "paid", fx: true });
    await expect(rawUpdate(f.line.id, SET)).resolves.toBe(1);
    await expect(
      asPromise(db.refundLine.update({ where: { id: f.line.id }, data: { approvedTotalCents: 900, fxRateMicros: 924600 } })),
    ).resolves.toBeTruthy();
  });

  it("the two rules are independent: on a paid numbered line the classification copies stay locked (even null -> set) while the rate rule is its own", async () => {
    const f = await line({ status: "paid", fx: true });
    await expect(
      asPromise(db.refundLine.update({ where: { id: f.line.id }, data: { motivo: "edited" } })),
    ).resolves.toBeTruthy();
    await expect(rawUpdate(f.line.id, `"accountNumber" = '6101', "accountName" = 'Ufficio'`)).rejects.toThrow(/locked/);
    // the same line of an approved request: the classification may be written, the rate still may not change
    const g = await line({ status: "approved", fx: true });
    await expect(rawUpdate(g.line.id, `"accountNumber" = '6101', "accountName" = 'Ufficio'`)).resolves.toBe(1);
    await expect(rawUpdate(g.line.id, `"fxRateMicros" = 1`)).rejects.toThrow(/write-once/);
  });
});

describe("refund_line CHECKs refuse their bad row (plan step 5)", () => {
  beforeEach(async () => {
    await truncateRefundTables();
  });
  afterAll(async () => {
    await truncateRefundTables();
  });

  const REJECT = (constraint: string | RegExp) => (typeof constraint === "string" ? new RegExp(constraint) : constraint);

  it("(control) a fully copied WellD CH EUR line, the boundaries included, is accepted", async () => {
    const f = await line({ numbered: false });
    await expect(
      rawUpdate(
        f.line.id,
        `"accountNumber" = '2620.1', "accountName" = 'Conto', "vatCode" = 'NOVAT', "vatRateBasisPoints" = 0, "fxRateMicros" = 999999999, "fxRateMonth" = '2026-03-01', "fxRateCopiedAt" = now()`,
      ),
    ).resolves.toBe(1);
    const g = await line({ numbered: false, currency: "CHF" });
    await expect(rawUpdate(g.line.id, `"vatCode" = 'IMP81', "vatRateBasisPoints" = 10000`)).resolves.toBe(1);
    await expect(rawUpdate(g.line.id, `"vatCode" = NULL, "vatRateBasisPoints" = NULL`)).resolves.toBe(1);
    const h = await line({ numbered: false, currency: "USD" });
    await expect(rawUpdate(h.line.id, `"fxRateMicros" = 1, "fxRateMonth" = '2026-03-01', "fxRateCopiedAt" = now()`)).resolves.toBe(1);
  });

  const cases: [string, string, LineOpts, string][] = [
    ["refund_line_account_copy_pair", "an account number without its name", { currency: "CHF" }, `"accountNumber" = '6101'`],
    ["refund_line_account_copy_pair", "an account name without its number", { currency: "CHF" }, `"accountName" = 'Ufficio'`],
    ["refund_line_vat_copy_pair", "a VAT code without its rate", { currency: "CHF" }, `"vatCode" = 'IMP81'`],
    ["refund_line_vat_copy_pair", "a VAT rate without its code", { currency: "CHF" }, `"vatRateBasisPoints" = 810`],
    ["refund_line_vat_rate_range", "a negative VAT rate", { currency: "CHF" }, `"vatCode" = 'X', "vatRateBasisPoints" = -1`],
    ["refund_line_vat_rate_range", "a VAT rate over 100 %", { currency: "CHF" }, `"vatCode" = 'X', "vatRateBasisPoints" = 10001`],
    ["refund_line_fx_all_or_none", "a rate with no month and no copy time", {}, `"fxRateMicros" = 924600`],
    ["refund_line_fx_all_or_none", "a month alone", {}, `"fxRateMonth" = '2026-03-01'`],
    ["refund_line_fx_all_or_none", "a rate and a month with no copy time", {}, `"fxRateMicros" = 924600, "fxRateMonth" = '2026-03-01'`],
    ["refund_line_fx_rate_range", "a rate of zero", {}, `"fxRateMicros" = 0, "fxRateMonth" = '2026-03-01', "fxRateCopiedAt" = now()`],
    ["refund_line_fx_rate_range", "a negative rate", {}, `"fxRateMicros" = -5, "fxRateMonth" = '2026-03-01', "fxRateCopiedAt" = now()`],
    ["refund_line_fx_rate_range", "a rate of 1e9", {}, `"fxRateMicros" = 1000000000, "fxRateMonth" = '2026-03-01', "fxRateCopiedAt" = now()`],
    ["refund_line_fx_month_is_expense_month", "another month than the expense's", {}, `"fxRateMicros" = 924600, "fxRateMonth" = '2026-04-01', "fxRateCopiedAt" = now()`],
    ["refund_line_fx_month_is_expense_month", "a month that is not its first day", {}, `"fxRateMicros" = 924600, "fxRateMonth" = '2026-03-02', "fxRateCopiedAt" = now()`],
    ["refund_line_fx_foreign_ch_only", "a rate on a CHF line", { currency: "CHF" }, `"fxRateMicros" = 924600, "fxRateMonth" = '2026-03-01', "fxRateCopiedAt" = now()`],
    ["refund_line_classification_ch_only", "an account copy on a WellD Italia line", { entity: "welld_it" }, `"accountNumber" = '6101', "accountName" = 'Ufficio'`],
    ["refund_line_classification_ch_only", "a VAT copy on a WellD Italia line", { entity: "welld_it" }, `"vatCode" = 'IMP81', "vatRateBasisPoints" = 810`],
    ["refund_line_classification_ch_only", "a rate copy on a WellD Italia line", { entity: "welld_it" }, `"fxRateMicros" = 924600, "fxRateMonth" = '2026-03-01', "fxRateCopiedAt" = now()`],
  ];

  for (const [constraint, label, opts, assignments] of cases) {
    it(`${constraint}: ${label}`, async () => {
      const f = await line({ numbered: false, ...opts });
      await expect(rawUpdate(f.line.id, assignments)).rejects.toThrow(REJECT(constraint));
      const reread = await db.refundLine.findUniqueOrThrow({ where: { id: f.line.id } });
      expect(reread.accountNumber).toBeNull();
      expect(reread.vatCodeCopy).toBeNull();
      expect(reread.fxRateMicros).toBeNull();
    });
  }

  it("a bad row is refused at INSERT too, not only at UPDATE", async () => {
    const request = await db.refundRequest.create({ data: { ownerUserId: "o", ownerEmail: "o@welld.ch" } });
    await expect(
      asPromise(
        db.refundLine.create({
          data: {
            requestId: request.id,
            date: new Date("2026-03-02"),
            type: "postal",
            motivo: "x",
            entity: "welld_it",
            currency: "EUR",
            requestedAmountCents: 100,
            accountNumber: "6101",
            accountName: "Ufficio",
          },
        }),
      ),
    ).rejects.toThrow(/refund_line_classification_ch_only/);
  });

  it("the month rule uses the expense DATE, not the time zone: the last and the first day of a month", async () => {
    const last = await line({ numbered: false, date: "2026-03-31" });
    await expect(rawUpdate(last.line.id, `"fxRateMicros" = 924600, "fxRateMonth" = '2026-03-01', "fxRateCopiedAt" = now()`)).resolves.toBe(1);
    const first = await line({ numbered: false, date: "2026-04-01" });
    await expect(rawUpdate(first.line.id, `"fxRateMicros" = 924600, "fxRateMonth" = '2026-04-01', "fxRateCopiedAt" = now()`)).resolves.toBe(1);
    const wrong = await line({ numbered: false, date: "2026-04-01" });
    await expect(rawUpdate(wrong.line.id, `"fxRateMicros" = 924600, "fxRateMonth" = '2026-03-01', "fxRateCopiedAt" = now()`)).rejects.toThrow(
      /refund_line_fx_month_is_expense_month/,
    );
  });

  it("every CHECK of the migration exists and is VALIDATED", async () => {
    const rows = await db.$queryRawUnsafe<{ conname: string; convalidated: boolean }[]>(
      `SELECT conname, convalidated FROM pg_constraint
       WHERE contype = 'c' AND conrelid IN ('refund_line'::regclass, 'expense_type_accounting_default'::regclass)`,
    );
    const byName = new Map(rows.map((r) => [r.conname, r.convalidated]));
    const expected = [
      "refund_line_account_copy_pair",
      "refund_line_vat_copy_pair",
      "refund_line_vat_rate_range",
      "refund_line_fx_all_or_none",
      "refund_line_fx_rate_range",
      "refund_line_fx_month_is_expense_month",
      "refund_line_fx_foreign_ch_only",
      "refund_line_classification_ch_only",
      "refund_line_receipt_all_or_none",
      "expense_type_accounting_default_ch_only",
      "expense_type_accounting_default_account_pair",
    ];
    for (const name of expected) expect([name, byName.get(name)]).toEqual([name, true]);
    // T58 (20261119200200_vat_defaults_retired): the VAT CHECKs of the defaults and the designation table's are gone
    for (const gone of [
      "expense_type_accounting_default_vat_all_or_none",
      "expense_type_accounting_default_vat_rate_range",
      "foreign_currency_vat_designation_ch_only",
      "foreign_currency_vat_designation_vat_all_or_none",
      "foreign_currency_vat_designation_vat_rate_range",
    ]) {
      expect([gone, byName.has(gone)]).toEqual([gone, false]);
    }
  });
});

describe("expense_type_accounting_default (the VAT half and the designation table were retired by T58)", () => {
  beforeEach(async () => {
    await truncateRefundTables();
  });
  afterAll(async () => {
    await truncateRefundTables();
  });

  const newDefault = (overrides: Record<string, unknown> = {}) =>
    db.expenseTypeAccountingDefault.create({
      data: {
        entity: "welld_ch",
        type: "travel_km",
        accountNumber: "5905",
        accountName: "Spese rimborsi chilometrici",
        ...actor,
        ...overrides,
      },
    });

  it("accepts a default account and 'no default' (both halves null)", async () => {
    await expect(asPromise(newDefault())).resolves.toBeTruthy();
    await expect(asPromise(newDefault({ accountNumber: null, accountName: null }))).resolves.toBeTruthy();
    expect(await db.expenseTypeAccountingDefault.count()).toBe(2);
  });

  const badDefaults: [string, string, Record<string, unknown>][] = [
    ["expense_type_accounting_default_ch_only", "an entity other than welld_ch", { entity: "welld_it" }],
    ["expense_type_accounting_default_account_pair", "a number without its name", { accountName: null }],
    ["expense_type_accounting_default_account_pair", "a name without its number", { accountNumber: null }],
  ];
  for (const [constraint, label, overrides] of badDefaults) {
    it(`${constraint}: ${label}`, async () => {
      await expect(asPromise(newDefault(overrides))).rejects.toThrow(new RegExp(constraint));
      expect(await db.expenseTypeAccountingDefault.count()).toBe(0);
    });
  }

  const tables = [["expense_type_accounting_default", () => newDefault(), "accountNumber"]] as const;
  for (const [table, make, column] of tables) {
    it(`${table} is append-only: UPDATE and DELETE raise and the row is untouched, TRUNCATE still resets it`, async () => {
      const row = await asPromise(make());
      await expect(
        asPromise(db.$executeRawUnsafe(`UPDATE "${table}" SET "${column}" = 'X' WHERE id = $1`, row.id)),
      ).rejects.toThrow(/append-only/);
      await expect(asPromise(db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE id = $1`, row.id))).rejects.toThrow(/append-only/);
      await expect(
        asPromise(db.expenseTypeAccountingDefault.update({ where: { id: row.id }, data: { accountNumber: "1" } })),
      ).rejects.toThrow();
      await expect(asPromise(db.expenseTypeAccountingDefault.delete({ where: { id: row.id } }))).rejects.toThrow();
      const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM "${table}" WHERE id = $1`, row.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]![column]).toBe("5905");

      await truncateRefundTables();
      expect(await db.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM "${table}"`)).toHaveLength(0);
    });
  }

  it("reads the newest row per (entity, type) by createdAt: the history is queryable and the latest wins", async () => {
    await newDefault({ createdAt: new Date("2026-01-01T00:00:00Z"), accountNumber: "5901", accountName: "Treno" });
    await newDefault({ createdAt: new Date("2026-02-01T00:00:00Z"), accountNumber: "5902", accountName: "Treno 2" });
    const latest = await db.expenseTypeAccountingDefault.findFirstOrThrow({
      where: { entity: "welld_ch", type: "travel_km" },
      orderBy: { createdAt: "desc" },
    });
    expect(latest.accountNumber).toBe("5902");
  });
});
