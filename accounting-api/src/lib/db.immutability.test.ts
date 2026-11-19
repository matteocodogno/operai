/**
 * The five tables are append-only AT THE DATABASE (T5, specs/20261119-accounting; AC-1.7, AC-1.12,
 * AC-1.13, AC-2.4; ADR 20260716-immutable-financial-audit-trail-refund). Modelled on refund-api's
 * `db.accounting-immutability.test.ts`, which stays there until T24.
 *
 * Real Postgres, no mocking: these tests exercise the raw SQL of the `20261119120000_init` migration,
 * not application code (there is none yet). A raw UPDATE or DELETE must raise on each table, with the
 * row provably untouched afterwards; so must the Prisma client, which sends the same SQL. Cleanup is
 * TRUNCATE, which does not fire row triggers.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "./db";
import { SQLSTATE, truncateAccountingTables, violation } from "../test-support/dbCleanup";

const actor = { createdByUserId: "admin-1", createdByEmail: "admin@welld.ch" };

let seq = 0;
const makeAccount = (entity: "welld_ch" | "welld_it" = "welld_ch", number = `59${String(10 + seq++).padStart(2, "0")}`) =>
  db.ledgerAccount.create({ data: { entity, number, name: "Spese rimborsi chilometrici", ...actor } });

const makeVatCode = (entity: "welld_ch" | "welld_it" = "welld_ch", code = `C${seq++}`, rateBasisPoints = 810) =>
  db.vatCode.create({ data: { entity, code, label: "IVA 8.1%", rateBasisPoints, ...actor } });

const makeFetchedRate = () =>
  db.exchangeRateEntry.create({
    data: {
      entity: "welld_ch",
      currency: "EUR",
      month: new Date("2026-03-01"),
      rateMicros: 924_600,
      origin: "fetched",
      sourceUrl: "https://www.backend-rates.bazg.admin.ch/api/xmlavgmonth?j=2026&m=03",
      sourceMonth: "2026-03",
      fetchedAt: new Date(),
      createdByUserId: "system:rates-fetch",
      createdByEmail: "system-rates-fetch@welld.ch",
    },
  });

/** One factory per table: returns the new row. */
const factories = {
  ledger_account: () => makeAccount(),
  vat_code: () => makeVatCode(),
  catalog_status_change: async () => {
    const account = await makeAccount();
    return db.catalogStatusChange.create({
      data: { entity: "welld_ch", ledgerAccountId: account.id, active: false, ...actor },
    });
  },
  exchange_rate_entry: () => makeFetchedRate(),
  exchange_rate_fetch_attempt: () =>
    db.exchangeRateFetchAttempt.create({
      data: {
        entity: "welld_ch",
        month: new Date("2026-03-01"),
        trigger: "manager",
        outcome: "ok",
        recorded: { EUR: 924_600 },
        actorUserId: "admin-1",
      },
    }),
} satisfies Record<string, () => Promise<{ id: string }>>;

type Table = keyof typeof factories;
const TABLES = Object.keys(factories) as Table[];

// A column that exists on every table, to give the UPDATE something to change.
const touched: Record<Table, { column: string; value: unknown }> = {
  ledger_account: { column: '"name"', value: "changed" },
  vat_code: { column: '"label"', value: "changed" },
  catalog_status_change: { column: '"active"', value: true },
  exchange_rate_entry: { column: '"rateMicros"', value: 1 },
  exchange_rate_fetch_attempt: { column: '"outcome"', value: "failed" },
};

beforeEach(truncateAccountingTables);
afterAll(truncateAccountingTables);

describe("every table is append-only at the database (AC-1.12, AC-1.13, AC-2.4)", () => {
  for (const table of TABLES) {
    it(`${table}: a raw UPDATE raises and leaves the row untouched`, async () => {
      const row = await factories[table]();
      const before = await db.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM "${table}" WHERE id = $1`, row.id);

      const refused = await violation(
        db.$executeRawUnsafe(`UPDATE "${table}" SET ${touched[table].column} = $1 WHERE id = $2`, touched[table].value, row.id),
      );
      expect(refused.code).toBe(SQLSTATE.raise);
      expect(refused.message).toMatch(/append-only/);
      expect(refused.message).toContain(table);

      expect(await db.$queryRawUnsafe(`SELECT * FROM "${table}" WHERE id = $1`, row.id)).toEqual(before);
    });

    it(`${table}: a raw DELETE raises and the row survives`, async () => {
      const row = await factories[table]();

      const refused = await violation(db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE id = $1`, row.id));
      expect(refused.code).toBe(SQLSTATE.raise);
      expect(refused.message).toMatch(/append-only/);

      expect(await db.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM "${table}" WHERE id = $1`, row.id)).toHaveLength(1);
    });

    it(`${table}: an UPDATE or DELETE that matches many rows raises on the first, and changes none`, async () => {
      await factories[table]();
      // A second row where the factory can make one (a second fetched rate of the same key is refused by its index).
      await factories[table]().catch(() => undefined);
      const count = Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}"`))[0]!.n);

      await violation(db.$executeRawUnsafe(`UPDATE "${table}" SET ${touched[table].column} = $1`, touched[table].value));
      await violation(db.$executeRawUnsafe(`DELETE FROM "${table}"`));

      expect(Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}"`))[0]!.n)).toBe(count);
    });
  }

  it("the Prisma client is refused the same way: update, updateMany, delete and deleteMany", async () => {
    const account = await makeAccount();
    const vat = await makeVatCode();
    const rate = await makeFetchedRate();
    const status = await factories.catalog_status_change();
    await factories.exchange_rate_fetch_attempt();

    expect((await violation(db.ledgerAccount.update({ where: { id: account.id }, data: { name: "x" } }))).message).toMatch(/append-only/);
    expect((await violation(db.vatCode.updateMany({ data: { label: "x" } }))).message).toMatch(/append-only/);
    expect((await violation(db.vatCode.delete({ where: { id: vat.id } }))).message).toMatch(/append-only/);
    expect((await violation(db.exchangeRateEntry.deleteMany({}))).message).toMatch(/append-only/);
    expect((await violation(db.exchangeRateEntry.update({ where: { id: rate.id }, data: { rateMicros: 1 } }))).message).toMatch(/append-only/);
    expect((await violation(db.catalogStatusChange.update({ where: { id: status.id }, data: { active: true } }))).message).toMatch(/append-only/);
    expect((await violation(db.exchangeRateFetchAttempt.deleteMany({}))).message).toMatch(/append-only/);

    expect(await db.ledgerAccount.count()).toBe(2); // the account, and the one behind the status row
    expect((await db.vatCode.findUniqueOrThrow({ where: { id: vat.id } })).label).toBe("IVA 8.1%");
  });

  it("(AC-1.7) vat_code.rateBasisPoints cannot be changed, by SQL or by the Prisma client", async () => {
    const vat = await makeVatCode("welld_ch", "IMP81", 810);

    expect((await violation(db.$executeRawUnsafe(`UPDATE "vat_code" SET "rateBasisPoints" = 770 WHERE id = $1`, vat.id))).message).toMatch(/append-only/);
    expect((await violation(db.vatCode.update({ where: { id: vat.id }, data: { rateBasisPoints: 770 } }))).message).toMatch(/append-only/);

    expect((await db.vatCode.findUniqueOrThrow({ where: { id: vat.id } })).rateBasisPoints).toBe(810);
  });

  it("(AC-1.12, AC-2.4) an entry's entity cannot be changed, on any table that carries one", async () => {
    for (const table of ["ledger_account", "vat_code", "catalog_status_change", "exchange_rate_entry", "exchange_rate_fetch_attempt"] as const) {
      const row = await factories[table]();
      const refused = await violation(db.$executeRawUnsafe(`UPDATE "${table}" SET "entity" = 'welld_it'::"Entity" WHERE id = $1`, row.id));
      expect(refused.code).toBe(SQLSTATE.raise);
      const [after] = await db.$queryRawUnsafe<{ entity: string }[]>(`SELECT "entity"::text AS entity FROM "${table}" WHERE id = $1`, row.id);
      expect(after!.entity).toBe("welld_ch");
    }
  });

  it("(AC-1.12) a number, a code and a name cannot be changed either", async () => {
    const account = await makeAccount("welld_ch", "5901");
    const vat = await makeVatCode("welld_ch", "IMP81");
    expect((await violation(db.$executeRawUnsafe(`UPDATE "ledger_account" SET "number" = '5902' WHERE id = $1`, account.id))).code).toBe(SQLSTATE.raise);
    expect((await violation(db.$executeRawUnsafe(`UPDATE "vat_code" SET "code" = 'IMP77' WHERE id = $1`, vat.id))).code).toBe(SQLSTATE.raise);
    expect((await violation(db.$executeRawUnsafe(`UPDATE "ledger_account" SET "createdByUserId" = 'someone-else' WHERE id = $1`, account.id))).code).toBe(SQLSTATE.raise);
  });

  it("(AC-2.4) a correction is a new row: the fetched row and the value it replaced stay as they were", async () => {
    const fetched = await makeFetchedRate();
    const corrected = await db.exchangeRateEntry.create({
      data: {
        entity: "welld_ch",
        currency: "EUR",
        month: new Date("2026-03-01"),
        rateMicros: 930_000,
        replacesRateMicros: fetched.rateMicros,
        origin: "corrected",
        ...actor,
      },
    });
    expect(corrected.replacesRateMicros).toBe(924_600);
    expect(await db.exchangeRateEntry.count()).toBe(2);
    expect((await db.exchangeRateEntry.findUniqueOrThrow({ where: { id: fetched.id } })).rateMicros).toBe(924_600);
  });

  it("(control) appending to every table works, and a status row after another is the normal reactivation path", async () => {
    for (const table of TABLES) expect(await factories[table]()).toBeTruthy();
    const account = await makeAccount("welld_ch", "6101");
    await db.catalogStatusChange.create({ data: { entity: "welld_ch", ledgerAccountId: account.id, active: false, ...actor } });
    await db.catalogStatusChange.create({ data: { entity: "welld_ch", ledgerAccountId: account.id, active: true, ...actor } });
    expect(await db.catalogStatusChange.count({ where: { ledgerAccountId: account.id } })).toBe(2);
  });

  it("(control) TRUNCATE, which test cleanup relies on, still empties the tables", async () => {
    for (const table of TABLES) await factories[table]().catch(() => undefined);
    await truncateAccountingTables();
    for (const table of TABLES) {
      expect(Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}"`))[0]!.n)).toBe(0);
    }
  });

  it("every foreign key is ON DELETE RESTRICT: a referenced account or VAT code is physically undeletable (the second wall behind the trigger)", async () => {
    const rows = await db.$queryRawUnsafe<{ conname: string; confdeltype: string }[]>(
      `SELECT conname::text AS conname, confdeltype::text AS confdeltype FROM pg_constraint WHERE contype = 'f'`,
    );
    expect(rows.map((r) => r.conname).sort()).toEqual([
      "catalog_status_change_ledgerAccountId_fkey",
      "catalog_status_change_vatCodeId_fkey",
    ]);
    expect(rows.every((r) => r.confdeltype === "r")).toBe(true); // 'r' = RESTRICT
  });

  it("the guard is registered on all five tables, BEFORE UPDATE and BEFORE DELETE, per row", async () => {
    const rows = await db.$queryRawUnsafe<{ tgrelid: string; tgname: string; tgtype: number }[]>(
      `SELECT tgrelid::regclass::text AS tgrelid, tgname::text AS tgname, tgtype::int AS tgtype
       FROM pg_trigger WHERE tgfoid = 'accounting_history_immutable'::regproc AND NOT tgisinternal`,
    );
    // tgtype bits: 1 = per row, 2 = BEFORE, 8 = DELETE, 16 = UPDATE.
    const byTable = new Map<string, number[]>();
    for (const r of rows) byTable.set(r.tgrelid, [...(byTable.get(r.tgrelid) ?? []), r.tgtype]);
    expect([...byTable.keys()].sort()).toEqual([...TABLES].sort());
    for (const types of byTable.values()) {
      expect(types.sort()).toEqual([1 | 2 | 8, 1 | 2 | 16].sort());
    }
  });
});
