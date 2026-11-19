/**
 * The CHECK constraints, the unique keys and the status-entity trigger of the init migration (T5,
 * specs/20261119-accounting; AC-1.2, AC-1.3, AC-1.5, AC-1.6, AC-1.7, AC-1.13, AC-2.5). The application
 * validates and trims first and answers with a field-level 422 (T8, T9, T12); these are the wall
 * behind it, so each one is proved here by feeding the database the bad row directly, and by naming the
 * constraint that refused it (a row refused for another reason would not prove this one).
 *
 * Real Postgres, no mocking. Cleanup is TRUNCATE, which does not fire row triggers.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "./db";
import { SQLSTATE, truncateAccountingTables, violation } from "../test-support/dbCleanup";

type Entity = "welld_ch" | "welld_it";

const actor = { createdByUserId: "admin-1", createdByEmail: "admin@welld.ch" };

const account = (over: { entity?: Entity; number?: string; name?: string } = {}) =>
  db.ledgerAccount.create({ data: { entity: "welld_ch", number: "5910", name: "Spese", ...over, ...actor } });

const vat = (over: { entity?: Entity; code?: string; label?: string; rateBasisPoints?: number } = {}) =>
  db.vatCode.create({ data: { entity: "welld_ch", code: "IMP81", label: "IVA 8.1%", rateBasisPoints: 810, ...over, ...actor } });

type RateInput = Parameters<typeof db.exchangeRateEntry.create>[0]["data"];
const fetched = (over: Partial<RateInput> = {}) =>
  db.exchangeRateEntry.create({
    data: {
      entity: "welld_ch",
      currency: "EUR",
      month: new Date("2026-03-01"),
      rateMicros: 924_600,
      origin: "fetched",
      sourceUrl: "https://www.backend-rates.bazg.admin.ch/api/xmlavgmonth?j=2026&m=03",
      sourceMonth: "2026-03",
      fetchedAt: new Date("2026-04-10T08:00:00.000Z"),
      createdByUserId: "system:rates-fetch",
      createdByEmail: "system-rates-fetch@welld.ch",
      ...over,
    } as RateInput,
  });
const corrected = (over: Partial<RateInput> = {}) =>
  db.exchangeRateEntry.create({
    data: {
      entity: "welld_ch",
      currency: "EUR",
      month: new Date("2026-03-01"),
      rateMicros: 930_000,
      origin: "corrected",
      ...actor,
      ...over,
    } as RateInput,
  });

/** The constraint a refusal names, e.g. `ledger_account_number_format`. */
const refusedBy = async (query: PromiseLike<unknown>, constraint: string, code: string = SQLSTATE.check) => {
  const v = await violation(query);
  expect(v.message).toContain(`"${constraint}"`);
  expect(v.code).toBe(code);
};

beforeEach(truncateAccountingTables);
afterAll(truncateAccountingTables);

describe("ledger_account (AC-1.2, AC-1.3)", () => {
  it("accepts a number of digits separated by single dots, up to 20 characters", async () => {
    let i = 0;
    for (const number of ["1", "5910", "6.1", "6.10.200", "0", "007", "1".repeat(20), "1.2.3.4.5.6.7.8.9.10"]) {
      expect(await account({ number }), number).toBeTruthy();
      i++;
    }
    expect(await db.ledgerAccount.count()).toBe(i);
  });

  it("refuses a number that is empty, has a non-digit, a misplaced dot, a blank, a newline or more than 20 characters", async () => {
    for (const number of ["", "abc", "12a", "1.", ".1", "1..2", "1.2.", " 12", "12 ", "1 2", "1\n", "1\n2", "-1", "+1", "1,5", "１２", "١٢", "1".repeat(21), `${"1".repeat(19)}.5`]) {
      await refusedBy(account({ number }), "ledger_account_number_format");
    }
    expect(await db.ledgerAccount.count()).toBe(0);
  });

  it("accepts a name of 1 to 120 characters and refuses an empty or blank one and one over 120", async () => {
    expect(await account({ number: "1", name: "x" })).toBeTruthy();
    expect(await account({ number: "2", name: "x".repeat(120) })).toBeTruthy();
    await refusedBy(account({ number: "3", name: "" }), "ledger_account_name_length");
    await refusedBy(account({ number: "4", name: "     " }), "ledger_account_name_length");
    await refusedBy(account({ number: "5", name: "x".repeat(121) }), "ledger_account_name_length");
    expect(await db.ledgerAccount.count()).toBe(2);
  });

  it("(AC-1.3) the number is unique per entity: a duplicate is refused, the same number in the other entity is accepted", async () => {
    await account({ number: "5905" });
    const v = await violation(account({ number: "5905" }));
    expect(v.code).toBe(SQLSTATE.unique);
    expect(v.message).toContain("ledger_account_entity_number_key");
    expect(await account({ entity: "welld_it", number: "5905" })).toBeTruthy();
  });

  it("(AC-1.3) concurrent additions of one number create exactly one account", async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () =>
        Promise.resolve(account({ number: "7000" })).then(
          () => "created" as const,
          async (error: unknown) =>
            (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: string } } } }).meta?.driverAdapterError?.cause?.originalCode ?? "other",
        ),
      ),
    );
    expect(outcomes.filter((o) => o === "created")).toHaveLength(1);
    expect(outcomes.filter((o) => o === SQLSTATE.unique)).toHaveLength(11);
    expect(await db.ledgerAccount.count()).toBe(1);
  });
});

describe("vat_code (AC-1.5, AC-1.6, AC-1.7)", () => {
  it("accepts a code of capital letters, digits, _ and -, 1 to 16 characters", async () => {
    for (const code of ["A", "IMP81", "IMP_81", "IMP-81", "0", "_", "-", "A".repeat(16), "EXP0"]) {
      expect(await vat({ code }), code).toBeTruthy();
    }
  });

  it("refuses a lower-case code (the application upper-cases first), an empty one, one with a blank or a symbol, and one over 16", async () => {
    for (const code of ["imp81", "Imp81", "", "A B", " A", "A ", "A.B", "A/B", "A\n", "À", "A".repeat(17)]) {
      await refusedBy(vat({ code }), "vat_code_code_format");
    }
    expect(await db.vatCode.count()).toBe(0);
  });

  it("accepts a label of 1 to 80 characters and refuses an empty or blank one and one over 80", async () => {
    expect(await vat({ code: "A", label: "x" })).toBeTruthy();
    expect(await vat({ code: "B", label: "x".repeat(80) })).toBeTruthy();
    await refusedBy(vat({ code: "C", label: "" }), "vat_code_label_length");
    await refusedBy(vat({ code: "D", label: "   " }), "vat_code_label_length");
    await refusedBy(vat({ code: "E", label: "x".repeat(81) }), "vat_code_label_length");
  });

  it("limits the rate to 0..10000 basis points (0 % to 100 %)", async () => {
    expect(await vat({ code: "ZERO", rateBasisPoints: 0 })).toBeTruthy();
    expect(await vat({ code: "FULL", rateBasisPoints: 10_000 })).toBeTruthy();
    expect(await vat({ code: "EIGHT1", rateBasisPoints: 810 })).toBeTruthy();
    await refusedBy(vat({ code: "NEG", rateBasisPoints: -1 }), "vat_code_rate_range");
    await refusedBy(vat({ code: "OVER", rateBasisPoints: 10_001 }), "vat_code_rate_range");
  });

  it("(AC-1.6) the code is unique per entity: a duplicate is refused, the same code in the other entity is accepted", async () => {
    await vat({ code: "IMP81" });
    const v = await violation(vat({ code: "IMP81" }));
    expect(v.code).toBe(SQLSTATE.unique);
    expect(v.message).toContain("vat_code_entity_code_key");
    expect(await vat({ entity: "welld_it", code: "IMP81" })).toBeTruthy();
  });

  it("(AC-1.6) `imp81` cannot sit next to `IMP81`: the lower-case spelling is refused by the code CHECK, not stored as another code", async () => {
    await vat({ code: "IMP81" });
    await refusedBy(vat({ code: "imp81" }), "vat_code_code_format");
    expect(await db.vatCode.count()).toBe(1);
  });
});

describe("catalog_status_change (AC-1.13)", () => {
  const status = (data: { entity?: Entity; ledgerAccountId?: string | null; vatCodeId?: string | null; active?: boolean }) =>
    db.catalogStatusChange.create({ data: { entity: "welld_ch", active: false, ...data, ...actor } });

  it("names exactly one entry: an account, or a VAT code, never none and never both", async () => {
    const a = await account();
    const v = await vat();
    expect(await status({ ledgerAccountId: a.id })).toBeTruthy();
    expect(await status({ vatCodeId: v.id })).toBeTruthy();
    await refusedBy(status({}), "catalog_status_change_one_of");
    await refusedBy(status({ ledgerAccountId: a.id, vatCodeId: v.id }), "catalog_status_change_one_of");
  });

  it("a row of another entity than its entry's is refused, for an account and for a VAT code, and nothing is written", async () => {
    const a = await account({ entity: "welld_ch" });
    const v = await vat({ entity: "welld_it", code: "IT22" });

    for (const query of [status({ entity: "welld_it", ledgerAccountId: a.id }), status({ entity: "welld_ch", vatCodeId: v.id })]) {
      const refused = await violation(query);
      expect(refused.code).toBe(SQLSTATE.raise);
      expect(refused.message).toMatch(/entity .* does not match the entity/);
    }
    expect(await db.catalogStatusChange.count()).toBe(0);

    // The matching entity is accepted, in both entities.
    expect(await status({ entity: "welld_ch", ledgerAccountId: a.id })).toBeTruthy();
    expect(await status({ entity: "welld_it", vatCodeId: v.id })).toBeTruthy();
  });

  it("the entity check cannot be got round by naming both entries: the one-of CHECK refuses it, whichever entity is sent", async () => {
    const a = await account({ entity: "welld_ch" });
    const v = await vat({ entity: "welld_ch" });
    await violation(status({ entity: "welld_ch", ledgerAccountId: a.id, vatCodeId: v.id }));
    await violation(status({ entity: "welld_it", ledgerAccountId: a.id, vatCodeId: v.id }));
    expect(await db.catalogStatusChange.count()).toBe(0);
  });

  it("an entry that does not exist is a foreign-key violation, not an entity mismatch", async () => {
    const refused = await violation(status({ ledgerAccountId: "no-such-account" }));
    expect(refused.code).toBe(SQLSTATE.foreignKey);
    expect((await violation(status({ vatCodeId: "no-such-vat-code" }))).code).toBe(SQLSTATE.foreignKey);
  });

  it("the trigger runs before every insert, whoever inserts (raw SQL included)", async () => {
    const a = await account({ entity: "welld_ch" });
    const refused = await violation(
      db.$executeRawUnsafe(
        `INSERT INTO "catalog_status_change" ("id", "entity", "ledgerAccountId", "active", "createdByUserId", "createdByEmail")
         VALUES ('raw-1', 'welld_it'::"Entity", $1, false, 'u', 'u@welld.ch')`,
        a.id,
      ),
    );
    expect(refused.code).toBe(SQLSTATE.raise);
    const triggers = await db.$queryRawUnsafe<{ tgname: string; tgtype: number }[]>(
      `SELECT tgname::text AS tgname, tgtype::int AS tgtype FROM pg_trigger
       WHERE tgrelid = 'catalog_status_change'::regclass AND tgname = 'catalog_status_entity_matches'`,
    );
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.tgtype & 1).toBe(1); // per row
    expect(triggers[0]!.tgtype & 2).toBe(2); // BEFORE
    expect(triggers[0]!.tgtype & 4).toBe(4); // INSERT
  });
});

describe("exchange_rate_entry (AC-2.2, AC-2.4, AC-2.5)", () => {
  it("(AC-2.5) the rate is greater than 0 and below 1000 (in micros: 0 < x < 1e9)", async () => {
    expect(await fetched({ rateMicros: 1 })).toBeTruthy();
    expect(await fetched({ currency: "USD", rateMicros: 999_999_999 })).toBeTruthy();
    for (const rateMicros of [0, -1, -5, 1_000_000_000, 1_000_000_001]) {
      await refusedBy(fetched({ currency: "GBP", rateMicros }), "exchange_rate_entry_rate_range");
      await refusedBy(corrected({ currency: "GBP", rateMicros }), "exchange_rate_entry_rate_range");
    }
  });

  it("(AC-2.4) the value a correction replaces is a rate too: in range when present, absent for a first correction", async () => {
    expect(await corrected({ replacesRateMicros: 924_600 })).toBeTruthy();
    expect(await corrected({ rateMicros: 931_000 })).toBeTruthy(); // nothing to replace: null
    for (const replacesRateMicros of [0, -1, 1_000_000_000]) {
      await refusedBy(corrected({ replacesRateMicros }), "exchange_rate_entry_replaces_range");
    }
  });

  it("the month is the first day of a month", async () => {
    expect(await fetched({ month: new Date("2026-03-01") })).toBeTruthy();
    expect(await fetched({ month: new Date("2026-02-01") })).toBeTruthy();
    for (const day of ["2026-03-02", "2026-03-15", "2026-03-31"]) {
      await refusedBy(fetched({ month: new Date(day) }), "exchange_rate_entry_month_first_day");
      await refusedBy(corrected({ month: new Date(day) }), "exchange_rate_entry_month_first_day");
    }
  });

  it("(AC-2.5) the entity's own currency has no rate: CHF for welld_ch, EUR for welld_it", async () => {
    await refusedBy(fetched({ entity: "welld_ch", currency: "CHF" }), "exchange_rate_entry_not_own_currency");
    await refusedBy(corrected({ entity: "welld_ch", currency: "CHF" }), "exchange_rate_entry_not_own_currency");
    await refusedBy(fetched({ entity: "welld_it", currency: "EUR" }), "exchange_rate_entry_not_own_currency");
    await refusedBy(corrected({ entity: "welld_it", currency: "EUR" }), "exchange_rate_entry_not_own_currency");
    // Another currency is a rate of the entity (the model allows it; the source decides which are fetched).
    expect(await fetched({ entity: "welld_ch", currency: "EUR" })).toBeTruthy();
    expect(await fetched({ entity: "welld_it", currency: "CHF", month: new Date("2026-04-01") })).toBeTruthy();
    expect(await fetched({ entity: "welld_it", currency: "USD", month: new Date("2026-05-01") })).toBeTruthy();
  });

  describe("(AC-2.1, AC-2.4) the origin decides which fields a row carries", () => {
    it("a fetched row has its source URL, its <monat> echo and its moment, and replaces nothing", async () => {
      await refusedBy(fetched({ sourceUrl: null }), "exchange_rate_entry_origin_fields");
      await refusedBy(fetched({ sourceMonth: null }), "exchange_rate_entry_origin_fields");
      await refusedBy(fetched({ fetchedAt: null }), "exchange_rate_entry_origin_fields");
      await refusedBy(fetched({ replacesRateMicros: 900_000 }), "exchange_rate_entry_origin_fields");
      await refusedBy(fetched({ sourceUrl: null, sourceMonth: null, fetchedAt: null }), "exchange_rate_entry_origin_fields");
      expect(await db.exchangeRateEntry.count()).toBe(0);
      expect(await fetched()).toBeTruthy();
    });

    it("a corrected row carries none of the fetch fields; it may carry the value it replaced, or not", async () => {
      await refusedBy(corrected({ sourceUrl: "https://example.test/x" }), "exchange_rate_entry_origin_fields");
      await refusedBy(corrected({ sourceMonth: "2026-03" }), "exchange_rate_entry_origin_fields");
      await refusedBy(corrected({ fetchedAt: new Date() }), "exchange_rate_entry_origin_fields");
      expect(await db.exchangeRateEntry.count()).toBe(0);
      expect(await corrected()).toBeTruthy();
      expect(await corrected({ replacesRateMicros: 930_000, rateMicros: 931_000 })).toBeTruthy();
    });
  });
});

describe("exchange_rate_fetch_attempt", () => {
  it("records an attempt per entity, with the trigger and the actor; the free-text members are the service's to constrain (T11)", async () => {
    const row = await db.exchangeRateFetchAttempt.create({
      data: {
        entity: "welld_ch",
        month: new Date("2026-03-01"),
        trigger: "consumer",
        outcome: "not_fetchable",
        errorCode: "http_503",
        actorUserId: "system:refund-api",
      },
    });
    expect(row.entity).toBe("welld_ch");
    expect(row.recorded).toBeNull();
  });
});
