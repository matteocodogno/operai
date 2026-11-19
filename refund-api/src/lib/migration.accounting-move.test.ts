/**
 * Migration `20261119120000_accounting_copies` on data (T16, specs/20261119-accounting;
 * plan § Data model steps 1-5 and 7, § Test strategy "mig", risk R7; ADR
 * 20261119-data-that-moves-from-one-service-to-another-before-the-release-moves-by-an-additive-migration-...).
 *
 * Scratch databases `refund_mig*` on the same server as DATABASE_URL (never the
 * test database itself): built migration by migration from the files of
 * `prisma/migrations` up to `20261119090000_accounting_export`, filled with
 * fixture rows (classified CH lines, a paid numbered line, EUR lines with old
 * rates, defaults and designation history), then the new migration is applied.
 * Each scratch database is dropped at the end.
 *
 * The old tables, FK columns and the ExchangeRateOrigin type must SURVIVE this
 * migration (their drops are T24's).
 *
 * T24 (`20261119130000_accounting_reference_moved_out`): the second describe
 * block brings a scratch database from the 20261118 state through BOTH
 * migrations back to back (as production runs them), and asserts the drops, that
 * what stays is untouched, and that the guard no longer references a dropped
 * column; the last blocks prove a fresh database ends in the same structure and
 * that the migration refuses, whole, to drop what the copies do not hold.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "../../prisma/migrations");
const BASE = "20261119090000_accounting_export";
const THIS = "20261119120000_accounting_copies";
const NEXT = "20261119130000_accounting_reference_moved_out";

const baseUrl = new URL(process.env["DATABASE_URL"]!);
const urlOf = (database: string) => {
  const u = new URL(baseUrl);
  u.pathname = `/${database}`;
  return u.toString();
};

const migrationNames = readdirSync(MIGRATIONS_DIR)
  .filter((n) => /^\d{14}_/.test(n))
  .sort();

/** Apply the migration files [from, to] of the chain, each as one multi-statement simple query (as Prisma does). */
async function apply(sql: SQL, to: string, from?: string) {
  for (const name of migrationNames) {
    if (from && name < from) continue;
    if (name > to) break;
    await sql.unsafe(readFileSync(join(MIGRATIONS_DIR, name, "migration.sql"), "utf8")).simple();
  }
}

const created = new Set<string>();
const admin = new SQL(urlOf(baseUrl.pathname.slice(1)), { max: 1 });

async function scratch(name: string): Promise<SQL> {
  expect(name).toMatch(/^refund_mig[a-z0-9_]*$/); // never anything but a scratch name
  await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${name}`);
  created.add(name);
  return new SQL(urlOf(name), { max: 1 });
}

/** A scratch database brought to a migration state with the fixture rows: `copies` = through THIS, `next` = through NEXT. */
async function scratchAt(name: string, state: "copies" | "next"): Promise<SQL> {
  const s = await scratch(name);
  await apply(s, BASE);
  await fixtures(s);
  await apply(s, THIS, THIS);
  if (state === "next") await apply(s, NEXT, NEXT);
  return s;
}

afterAll(async () => {
  for (const name of created) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.close();
}, 60_000); // a dozen scratch databases to drop, under load (the 5 s default of a hook is not enough)

// ─── Fixtures at the 20261119090000 schema ───────────────────────────────────

async function insert(sql: SQL, table: string, row: Record<string, unknown>) {
  const cols = Object.keys(row);
  const text = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`;
  await sql.unsafe(text, Object.values(row) as never[]);
}

const by = (id = "admin-7") => ({ createdByUserId: id, createdByEmail: `${id}@welld.ch` });

interface LineFixture {
  id: string;
  request: string;
  date: string;
  entity?: "welld_ch" | "welld_it";
  currency?: "CHF" | "EUR" | "USD" | "GBP";
  receipt?: number;
  account?: string;
  vat?: string;
  accountDefault?: boolean;
  vatDefault?: boolean;
  rejected?: boolean;
}

async function fixtures(sql: SQL) {
  const t = (n: number) => `2026-03-0${n}T10:00:00.000`;
  // catalog
  await insert(sql, "ledger_account", { id: "acc-train", entity: "welld_ch", number: "5901", name: "Spese di viaggio: treno", ...by(), createdAt: t(1) });
  await insert(sql, "ledger_account", { id: "acc-office", entity: "welld_ch", number: "6101", name: "Spese materiale ufficio", ...by(), createdAt: t(1) });
  await insert(sql, "ledger_account", { id: "acc-dot", entity: "welld_ch", number: "2620.1", name: "Conto con punto", ...by(), createdAt: t(1) });
  await insert(sql, "vat_code", { id: "vat-imp81", entity: "welld_ch", code: "IMP81", label: "IVA 8.1%", rateBasisPoints: 810, ...by(), createdAt: t(1) });
  await insert(sql, "vat_code", { id: "vat-novat", entity: "welld_ch", code: "NOVAT", label: "Senza IVA", rateBasisPoints: 0, ...by(), createdAt: t(1) });
  await insert(sql, "accounting_catalog_status", { id: "st-1", ledgerAccountId: "acc-dot", active: false, ...by("admin-9"), createdAt: t(2) });
  // defaults history: a changed default (two rows), a half default, a null half
  const d = (id: string, type: string, a: string | null, v: string | null, who: string, n: number) =>
    insert(sql, "expense_type_default", { id, entity: "welld_ch", type, ledgerAccountId: a, vatCodeId: v, ...by(who), createdAt: t(n) });
  await d("def-1", "travel_train", "acc-train", "vat-imp81", "admin-7", 1);
  await d("def-2", "postal", "acc-office", "vat-novat", "admin-7", 2);
  await d("def-3", "postal", "acc-train", "vat-novat", "admin-8", 3);
  await d("def-4", "telephone", "acc-office", null, "admin-7", 4);
  await d("def-5", "stationery", null, "vat-imp81", "admin-7", 4);
  // designation history (value = a VAT code id, or null = cleared) + two unrelated keys that must not be carried
  const s = (id: string, key: string, value: string | null, who: string, n: number) =>
    insert(sql, "refund_setting", { id, key, value, ...by(who), createdAt: t(n) });
  const KEY = "accounting.welld_ch.foreign-currency-vat-code";
  await s("set-1", KEY, "vat-novat", "admin-7", 1);
  await s("set-2", KEY, "vat-imp81", "admin-8", 2);
  await s("set-3", KEY, null, "admin-7", 3);
  await s("set-4", KEY, "vat-novat", "admin-7", 4);
  await s("set-x", "accounting-distribution-email", "accounting@welld.ch", "admin-7", 4);
  await s("set-y", "accounting-release-completed-at", "2026-03-01T00:00:00.000Z", "system:accounting-release", 4);
  // rates: EUR 2026-03 fetched, then two corrections (the later wins), EUR 2026-02 fetched, USD and GBP 2026-03
  // fetched, none for EUR 2026-04
  const r = (id: string, currency: string, month: string, rate: number, origin: "fetched" | "corrected", createdAt: string) =>
    insert(sql, "exchange_rate_entry", {
      id,
      currency,
      month,
      rateMicros: rate,
      origin,
      ...by(origin === "fetched" ? "system:fx-fetch" : "admin-7"),
      createdAt,
      ...(origin === "fetched" ? { sourceUrl: "https://example.invalid/x", sourceMonth: month.slice(0, 7), fetchedAt: createdAt } : {}),
    });
  await r("rate-eur-3-f", "EUR", "2026-03-01", 924600, "fetched", "2026-04-05T09:00:00.000");
  await r("rate-eur-3-c1", "EUR", "2026-03-01", 930000, "corrected", "2026-04-06T09:00:00.000");
  await r("rate-eur-3-c2", "EUR", "2026-03-01", 931000, "corrected", "2026-04-07T09:00:00.000");
  await r("rate-eur-2-f", "EUR", "2026-02-01", 910000, "fetched", "2026-03-05T09:00:00.000");
  // USD: a correction recorded BEFORE the fetched row (the fetched row is the newer one, the correction still wins)
  await r("rate-usd-3-c", "USD", "2026-03-01", 870000, "corrected", "2026-04-03T09:00:00.000");
  await r("rate-usd-3-f", "USD", "2026-03-01", 880000, "fetched", "2026-04-05T09:00:00.000");
  await r("rate-gbp-3-f", "GBP", "2026-03-01", 1100000, "fetched", "2026-04-05T09:00:00.000");
  await insert(sql, "exchange_rate_fetch_attempt", { id: "att-1", month: "2026-03-01", trigger: "admin", outcome: "ok", actorUserId: "admin-7" });

  // requests and lines
  const req = (id: string, status: string, owner: string) =>
    insert(sql, "refund_request", { id, ownerUserId: owner, ownerEmail: `${owner}@welld.ch`, status, updatedAt: "2026-04-01T00:00:00.000" });
  await req("rq-paid", "paid", "owner-1");
  await req("rq-appr", "approved", "owner-2");
  await req("rq-subm", "submitted", "owner-3");
  await req("rq-draft", "draft", "owner-4");
  await req("rq-legacy", "paid", "owner-5");

  const line = async (l: LineFixture) => {
    const receipt = l.receipt
      ? {
          receiptNumber: `MC26/${String(l.receipt).padStart(3, "0")}`,
          receiptOwnerUserId: `owner-of-${l.request}`,
          receiptYear: 2026,
          receiptSeq: l.receipt,
          numberedAt: "2026-04-01T08:00:00.000",
        }
      : {};
    await insert(sql, "refund_line", {
      id: l.id,
      requestId: l.request,
      date: l.date,
      type: "office_material",
      motivo: "m",
      entity: l.entity ?? "welld_ch",
      currency: l.currency ?? "CHF",
      requestedAmountCents: 12345,
      approvedTotalCents: 12345,
      updatedAt: "2026-04-01T07:00:00.000",
      ledgerAccountId: l.account ?? null,
      ledgerAccountIsDefault: l.account ? (l.accountDefault ?? true) : null,
      vatCodeId: l.vat ?? null,
      vatCodeIsDefault: l.vat ? (l.vatDefault ?? true) : null,
      ...(l.rejected
        ? { rejectionReason: "no", rejectedAt: "2026-04-01T00:00:00.000", rejectedByUserId: "a", rejectedByEmail: "a@welld.ch", approvedTotalCents: 0 }
        : {}),
      ...receipt,
    });
  };
  // paid + numbered
  await line({ id: "L-chf", request: "rq-paid", date: "2026-03-02", receipt: 1, account: "acc-office", vat: "vat-imp81", accountDefault: false });
  await line({ id: "L-eur", request: "rq-paid", date: "2026-03-10", currency: "EUR", receipt: 2, account: "acc-office", vat: "vat-novat" });
  await line({ id: "L-usd", request: "rq-paid", date: "2026-03-11", currency: "USD", receipt: 3, account: "acc-train", vat: "vat-novat" });
  await line({ id: "L-gbp", request: "rq-paid", date: "2026-03-20", currency: "GBP", receipt: 4, account: "acc-office", vat: "vat-novat" });
  await line({ id: "L-eur-mar31", request: "rq-paid", date: "2026-03-31", currency: "EUR", receipt: 5, account: "acc-office", vat: "vat-novat" });
  await line({ id: "L-eur-feb28", request: "rq-paid", date: "2026-02-28", currency: "EUR", receipt: 6, account: "acc-office", vat: "vat-novat" });
  await line({ id: "L-eur-pending-paid", request: "rq-paid", date: "2026-04-10", currency: "EUR", receipt: 7, account: "acc-office", vat: "vat-novat" });
  await line({ id: "L-it", request: "rq-paid", date: "2026-03-02", entity: "welld_it", currency: "EUR", receipt: 8 });
  await line({ id: "L-rejected", request: "rq-paid", date: "2026-03-02", currency: "EUR", rejected: true });
  // approved
  await line({ id: "L-eur-apr", request: "rq-appr", date: "2026-04-05", currency: "EUR", receipt: 1, account: "acc-office", vat: "vat-novat" });
  await line({ id: "L-eur-mar", request: "rq-appr", date: "2026-03-15", currency: "EUR", receipt: 2, account: "acc-office", vat: "vat-novat" });
  await line({ id: "L-chf-hand", request: "rq-appr", date: "2026-04-06", receipt: 3, account: "acc-train", vat: "vat-novat", vatDefault: false });
  await line({ id: "L-eur-odd-rejected", request: "rq-appr", date: "2026-03-16", currency: "EUR", receipt: 4, rejected: true });
  // submitted / draft: copies of a hand classification, no number, no rate; an odd numbered EUR line has none either
  await line({ id: "L-sub-hand", request: "rq-subm", date: "2026-03-02", account: "acc-train", vat: "vat-imp81", accountDefault: false, vatDefault: false });
  await line({ id: "L-sub-eur", request: "rq-subm", date: "2026-03-12", currency: "EUR" });
  await line({ id: "L-sub-eur-numbered", request: "rq-subm", date: "2026-03-13", currency: "EUR", receipt: 1 });
  await line({ id: "L-draft", request: "rq-draft", date: "2026-03-14", currency: "EUR", account: "acc-office", accountDefault: false });
  // a legacy line of a paid request: never numbered, never classified
  await line({ id: "L-legacy-eur", request: "rq-legacy", date: "2026-03-03", currency: "EUR" });
}

type Row = Record<string, any>;
const rows = async (sql: SQL, text: string, params: unknown[] = []): Promise<Row[]> => Array.from(await sql.unsafe(text, params as never[]));

function pick(row: Row, keys: string[]): Row {
  return Object.fromEntries(keys.map((k) => [k, row[k]]));
}

// Expected copies per line, written by hand from the fixture (not derived from the SQL under test).
const EXPECTED_COPIES: Record<string, Partial<Row>> = {
  "L-chf": { accountNumber: "6101", accountName: "Spese materiale ufficio", vatCode: "IMP81", vatRateBasisPoints: 810, ledgerAccountIsDefault: false, vatCodeIsDefault: true },
  "L-eur": { accountNumber: "6101", vatCode: "NOVAT", vatRateBasisPoints: 0 },
  "L-usd": { accountNumber: "5901", accountName: "Spese di viaggio: treno", vatCode: "NOVAT" },
  "L-chf-hand": { accountNumber: "5901", vatCode: "NOVAT", vatRateBasisPoints: 0, ledgerAccountIsDefault: true, vatCodeIsDefault: false },
  "L-sub-hand": { accountNumber: "5901", accountName: "Spese di viaggio: treno", vatCode: "IMP81", vatRateBasisPoints: 810, ledgerAccountIsDefault: false, vatCodeIsDefault: false },
  "L-draft": { accountNumber: "6101", vatCode: null, vatRateBasisPoints: null, ledgerAccountIsDefault: false, vatCodeIsDefault: null },
  "L-it": { accountNumber: null, accountName: null, vatCode: null, vatRateBasisPoints: null },
  "L-rejected": { accountNumber: null, vatCode: null },
  "L-legacy-eur": { accountNumber: null, accountName: null, vatCode: null, vatRateBasisPoints: null },
};

// The rate in effect is copied for a numbered, non-rejected, non-CHF CH line of an approved or paid request: the expense
// month, then the latest correction, else the fetched one. `null` = stays rate pending.
const EXPECTED_FX: Record<string, { rate: number; month: string } | null> = {
  "L-eur": { rate: 931000, month: "2026-03-01" }, // the LATER of two corrections
  "L-usd": { rate: 870000, month: "2026-03-01" }, // a correction older than the fetched row still wins
  "L-gbp": { rate: 1100000, month: "2026-03-01" },
  "L-eur-mar31": { rate: 931000, month: "2026-03-01" }, // last day of the month
  "L-eur-feb28": { rate: 910000, month: "2026-02-01" }, // the expense month's, not the latest
  "L-eur-mar": { rate: 931000, month: "2026-03-01" }, // an approved (unpaid) request
  "L-eur-pending-paid": null, // no April rate
  "L-eur-apr": null,
  "L-chf": null, // CHF
  "L-chf-hand": null,
  "L-it": null, // WellD Italia
  "L-rejected": null,
  "L-eur-odd-rejected": null, // numbered but rejected
  "L-sub-eur": null, // not approved
  "L-sub-eur-numbered": null, // numbered but the request is only submitted
  "L-draft": null,
  "L-legacy-eur": null, // paid but never numbered: the release script numbers it and copies the rate
  "L-sub-hand": null,
};

describe("20261119120000_accounting_copies carries the data of a 20261118 database", () => {
  let sql: SQL;
  let before: Row[];

  beforeAll(async () => {
    sql = await scratch("refund_mig");
    await apply(sql, BASE);
    await fixtures(sql);
    before = await rows(
      sql,
      `SELECT id, "updatedAt", "ledgerAccountId", "vatCodeId", "ledgerAccountIsDefault", "vatCodeIsDefault", "receiptNumber" FROM refund_line ORDER BY id`,
    );
    await apply(sql, THIS, THIS);
  }, 60_000);

  it("the scratch database was at 20261119090000 when the fixture ran (this migration follows it directly)", () => {
    expect(migrationNames.indexOf(THIS)).toBe(migrationNames.indexOf(BASE) + 1);
    expect(before.length).toBe(Object.keys(EXPECTED_FX).length);
  });

  it("copies the account and the VAT code of the lines, by hand-written expectations", async () => {
    const lines = new Map((await rows(sql, `SELECT * FROM refund_line`)).map((l) => [l.id, l]));
    for (const [id, expected] of Object.entries(EXPECTED_COPIES)) {
      expect({ id, ...pick(lines.get(id)!, Object.keys(expected)) }).toEqual({ id, ...expected });
    }
  });

  it("every copy equals the join on the old FK columns, for every line", async () => {
    const bad = await rows(
      sql,
      `SELECT l.id FROM refund_line l
       LEFT JOIN ledger_account a ON a.id = l."ledgerAccountId"
       LEFT JOIN vat_code v ON v.id = l."vatCodeId"
       WHERE l."accountNumber" IS DISTINCT FROM a."number" OR l."accountName" IS DISTINCT FROM a."name"
          OR l."vatCode" IS DISTINCT FROM v."code" OR l."vatRateBasisPoints" IS DISTINCT FROM v."rateBasisPoints"`,
    );
    expect(bad).toEqual([]);
  });

  it("changes nothing else about a line: old FKs, flags, receipt number and updatedAt are as before", async () => {
    const after = await rows(
      sql,
      `SELECT id, "updatedAt", "ledgerAccountId", "vatCodeId", "ledgerAccountIsDefault", "vatCodeIsDefault", "receiptNumber" FROM refund_line ORDER BY id`,
    );
    expect(after).toEqual(before);
  });

  it("copies the rate in effect per line (corrected over fetched, the later correction, the expense month), and only where due", async () => {
    const lines = new Map(
      (await rows(sql, `SELECT id, "fxRateMicros", "fxRateMonth"::text AS month, "fxRateCopiedAt" FROM refund_line`)).map((l) => [l.id, l]),
    );
    for (const [id, expected] of Object.entries(EXPECTED_FX)) {
      const l = lines.get(id)!;
      if (expected === null) {
        expect([id, l.fxRateMicros, l.month, l.fxRateCopiedAt]).toEqual([id, null, null, null]);
      } else {
        expect([id, l.fxRateMicros, l.month]).toEqual([id, expected.rate, expected.month]);
        expect(l.fxRateCopiedAt).toBeInstanceOf(Date);
      }
    }
  });

  it("the copy time is the time of the migration, in UTC (TIMESTAMP(3) holds UTC wall time)", async () => {
    const [r] = await rows(
      sql,
      `SELECT min("fxRateCopiedAt") AS lo, max("fxRateCopiedAt") AS hi, (now() AT TIME ZONE 'UTC') AS now FROM refund_line`,
    );
    // Both sides are read as the same wall clock, so their difference does not depend on the client's time zone.
    expect(Math.abs(r!.now.getTime() - r!.hi.getTime())).toBeLessThan(120_000);
    expect(r!.hi.getTime() - r!.lo.getTime()).toBeLessThan(5_000);
  });

  it("carries the defaults history with the same ids, actors and times, and a null half stays null", async () => {
    const carried = await rows(sql, `SELECT * FROM expense_type_accounting_default ORDER BY id`);
    expect(carried.map((c) => c.id)).toEqual(["def-1", "def-2", "def-3", "def-4", "def-5"]);
    const old = new Map((await rows(sql, `SELECT * FROM expense_type_default`)).map((d) => [d.id, d]));
    for (const c of carried) {
      const o = old.get(c.id)!;
      expect([c.entity, c.type, c.createdByUserId, c.createdByEmail]).toEqual([o.entity, o.type, o.createdByUserId, o.createdByEmail]);
      expect(c.createdAt.getTime()).toBe(o.createdAt.getTime());
    }
    const byId = new Map(carried.map((c) => [c.id, c]));
    expect(pick(byId.get("def-1")!, ["accountNumber", "accountName", "vatCode", "vatLabel", "vatRateBasisPoints"])).toEqual({
      accountNumber: "5901",
      accountName: "Spese di viaggio: treno",
      vatCode: "IMP81",
      vatLabel: "IVA 8.1%",
      vatRateBasisPoints: 810,
    });
    // the changed default keeps both rows, the later actor included
    expect([byId.get("def-2")!.accountNumber, byId.get("def-2")!.createdByUserId]).toEqual(["6101", "admin-7"]);
    expect([byId.get("def-3")!.accountNumber, byId.get("def-3")!.createdByUserId]).toEqual(["5901", "admin-8"]);
    expect(pick(byId.get("def-4")!, ["accountNumber", "vatCode", "vatLabel", "vatRateBasisPoints"])).toEqual({
      accountNumber: "6101",
      vatCode: null,
      vatLabel: null,
      vatRateBasisPoints: null,
    });
    expect(pick(byId.get("def-5")!, ["accountNumber", "accountName", "vatCode"])).toEqual({ accountNumber: null, accountName: null, vatCode: "IMP81" });
  });

  it("carries the designation history with the same ids, actors and times; a cleared row stays cleared; other keys are not carried", async () => {
    const carried = await rows(sql, `SELECT * FROM foreign_currency_vat_designation ORDER BY "createdAt", id`);
    expect(carried.map((c) => [c.id, c.vatCode, c.vatLabel, c.vatRateBasisPoints, c.createdByUserId])).toEqual([
      ["set-1", "NOVAT", "Senza IVA", 0, "admin-7"],
      ["set-2", "IMP81", "IVA 8.1%", 810, "admin-8"],
      ["set-3", null, null, null, "admin-7"],
      ["set-4", "NOVAT", "Senza IVA", 0, "admin-7"],
    ]);
    expect(carried.every((c) => c.entity === "welld_ch")).toBe(true);
    const old = new Map((await rows(sql, `SELECT * FROM refund_setting`)).map((d) => [d.id, d]));
    for (const c of carried) {
      expect(c.createdAt.getTime()).toBe(old.get(c.id)!.createdAt.getTime());
      expect(c.createdByEmail).toBe(old.get(c.id)!.createdByEmail);
    }
    // the immutable old settings rows are left in place, unread
    expect((await rows(sql, `SELECT count(*)::int AS n FROM refund_setting`))[0]!.n).toBe(6);
  });

  it("the old tables, the old FK columns and the old enum SURVIVE (their drops are T24)", async () => {
    const tables = (await rows(sql, `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).map((t) => t.tablename);
    for (const t of [
      "ledger_account",
      "vat_code",
      "accounting_catalog_status",
      "expense_type_default",
      "exchange_rate_entry",
      "exchange_rate_fetch_attempt",
      "receipt_counter",
      "refund_batch_export",
    ]) {
      expect(tables).toContain(t);
    }
    const cols = (await rows(sql, `SELECT column_name FROM information_schema.columns WHERE table_name = 'refund_line'`)).map((c) => c.column_name);
    expect(cols).toEqual(expect.arrayContaining(["ledgerAccountId", "vatCodeId", "vatCode", "accountNumber", "fxRateMicros"]));
    expect((await rows(sql, `SELECT count(*)::int AS n FROM pg_type WHERE typname = 'ExchangeRateOrigin'`))[0]!.n).toBe(1);
    expect((await rows(sql, `SELECT count(*)::int AS n FROM exchange_rate_entry`))[0]!.n).toBe(7);
    expect((await rows(sql, `SELECT count(*)::int AS n FROM ledger_account`))[0]!.n).toBe(3);
    const fks = (await rows(sql, `SELECT conname FROM pg_constraint WHERE contype = 'f' AND conrelid = 'refund_line'::regclass`)).map((c) => c.conname);
    expect(fks).toEqual(expect.arrayContaining(["refund_line_ledgerAccountId_fkey", "refund_line_vatCodeId_fkey"]));
  });

  it("every CHECK is validated, the new triggers exist, the enum value was added", async () => {
    const bad = await rows(sql, `SELECT conname FROM pg_constraint WHERE contype = 'c' AND NOT convalidated`);
    expect(bad).toEqual([]);
    const triggers = (await rows(sql, `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal`)).map((t) => t.tgname);
    for (const t of [
      "expense_type_accounting_default_no_update",
      "expense_type_accounting_default_no_delete",
      "foreign_currency_vat_designation_no_update",
      "foreign_currency_vat_designation_no_delete",
      "refund_line_accounting_guard_update",
      "refund_line_accounting_guard_delete",
    ]) {
      expect(triggers).toContain(t);
    }
    const labels = (
      await rows(sql, `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'AuditAction'`)
    ).map((r) => r.enumlabel);
    expect(labels).toContain("line_rate_copied");
  });

  // Mutates rows, so it runs on a scratch database of its own: the other tests of this block read `sql` and must not
  // depend on whether (or before/after what) this one ran (D-5: green only in declaration order before).
  it("guard v2 is in force on the migrated data: copies of a paid numbered line are locked, a pending rate is copied once", async () => {
    const own = await scratchAt("refund_mig_guard", "copies");
    try {
      await expect(own.unsafe(`UPDATE refund_line SET "accountNumber" = '9999', "accountName" = 'x' WHERE id = 'L-chf'`)).rejects.toThrow(/locked/);
      await expect(own.unsafe(`UPDATE refund_line SET "vatCode" = 'X', "vatRateBasisPoints" = 1 WHERE id = 'L-usd'`)).rejects.toThrow(/locked/);
      await expect(own.unsafe(`UPDATE refund_line SET "fxRateMicros" = 1 WHERE id = 'L-eur'`)).rejects.toThrow(/write-once/);
      // the pending line of the paid request: null -> set is the first export's copy, then it is frozen
      await own.unsafe(
        `UPDATE refund_line SET "fxRateMicros" = 940000, "fxRateMonth" = '2026-04-01', "fxRateCopiedAt" = now() WHERE id = 'L-eur-pending-paid'`,
      );
      await expect(own.unsafe(`UPDATE refund_line SET "fxRateMicros" = 940001 WHERE id = 'L-eur-pending-paid'`)).rejects.toThrow(/write-once/);
      // a legacy line (no number) of a paid request is still classifiable by the release script
      await own.unsafe(`UPDATE refund_line SET "accountNumber" = '6101', "accountName" = 'Spese materiale ufficio' WHERE id = 'L-legacy-eur'`);
    } finally {
      await own.close();
    }
  }, 60_000);

  it("the new tables are append-only", async () => {
    await expect(sql.unsafe(`UPDATE expense_type_accounting_default SET "accountNumber" = '1' WHERE id = 'def-1'`)).rejects.toThrow(/append-only/);
    await expect(sql.unsafe(`DELETE FROM foreign_currency_vat_designation WHERE id = 'set-1'`)).rejects.toThrow(/append-only/);
  });

  it("a fresh database applies every migration and ends with the same structure as the carried one", async () => {
    const fresh = await scratch("refund_mig_zero");
    await apply(fresh, THIS);
    const structure = (s: SQL) =>
      rows(
        s,
        `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name <> '_prisma_migrations' ORDER BY table_name, column_name`,
      );
    expect(await structure(fresh)).toEqual(await structure(sql));
    const constraints = (s: SQL) =>
      rows(s, `SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint ORDER BY 1, 2`);
    expect(await constraints(fresh)).toEqual(await constraints(sql));
    const guard = (s: SQL) => rows(s, `SELECT pg_get_functiondef('refund_line_accounting_guard'::regproc) AS def`);
    expect(await guard(fresh)).toEqual(await guard(sql));
    await fresh.close();
  }, 60_000);
});

describe("20261119120000_accounting_copies fails loudly, and whole, on odd rows (risk R7)", () => {
  async function oddDatabase(name: string, mutate: (sql: SQL) => Promise<unknown>) {
    const sql = await scratch(name);
    await apply(sql, BASE);
    await fixtures(sql);
    await mutate(sql);
    return sql;
  }
  const migrate = (sql: SQL) => apply(sql, THIS, THIS);

  async function expectAtomicFailure(sql: SQL, message: RegExp) {
    await expect(migrate(sql)).rejects.toThrow(message);
    // one implicit transaction: nothing of it is left (no new table, no new column, the guard is still v1)
    const leftovers = await rows(
      sql,
      `SELECT to_regclass('expense_type_accounting_default') AS t, to_regclass('foreign_currency_vat_designation') AS d`,
    );
    expect(leftovers[0]).toEqual({ t: null, d: null });
    const cols = await rows(
      sql,
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'refund_line' AND column_name IN ('accountNumber', 'fxRateMicros')`,
    );
    expect(cols).toEqual([]);
    const guard = await rows(sql, `SELECT pg_get_functiondef('refund_line_accounting_guard'::regproc) ~ 'ledgerAccountId' AS v1`);
    expect(guard[0]!.v1).toBe(true);
  }

  it("a hand-made WellD Italia line with a ledger account names refund_line_classification_ch_only", async () => {
    // (a numbered line of a paid request would be refused by the old guard itself, so the odd line is an unnumbered one)
    const sql = await oddDatabase("refund_mig_odd1", (s) =>
      insert(s, "refund_line", {
        id: "L-it-odd",
        requestId: "rq-subm",
        date: "2026-03-02",
        type: "postal",
        motivo: "m",
        entity: "welld_it",
        currency: "EUR",
        requestedAmountCents: 100,
        updatedAt: "2026-04-01T07:00:00.000",
        ledgerAccountId: "acc-office",
        ledgerAccountIsDefault: false,
      }),
    );
    await expectAtomicFailure(sql, /refund_line_classification_ch_only/);
    await sql.close();
  }, 60_000);

  it("a designation whose value names no WellD CH VAT code stops the carry and names the setting row", async () => {
    const sql = await oddDatabase("refund_mig_odd2", (s) =>
      insert(s, "refund_setting", {
        id: "set-dangling",
        key: "accounting.welld_ch.foreign-currency-vat-code",
        value: "no-such-vat",
        ...by(),
        createdAt: "2026-05-01T00:00:00.000",
      }),
    );
    await expectAtomicFailure(sql, /set-dangling/);
    await sql.close();
  }, 60_000);

  it("an old rate that cannot be a valid copy (>= 1e9) names refund_line_fx_rate_range", async () => {
    const sql = await oddDatabase("refund_mig_odd3", (s) =>
      insert(s, "exchange_rate_entry", {
        id: "rate-huge",
        currency: "EUR",
        month: "2026-03-01",
        rateMicros: 1_500_000_000,
        origin: "corrected",
        ...by(),
        createdAt: "2026-04-09T09:00:00.000",
      }),
    );
    await expectAtomicFailure(sql, /refund_line_fx_rate_range/);
    await sql.close();
  }, 60_000);

  it("a default of another entity names expense_type_accounting_default_ch_only", async () => {
    const sql = await oddDatabase("refund_mig_odd4", (s) =>
      insert(s, "expense_type_default", {
        id: "def-it",
        entity: "welld_it",
        type: "postal",
        ledgerAccountId: null,
        vatCodeId: null,
        ...by(),
        createdAt: "2026-05-01T00:00:00.000",
      }),
    );
    await expectAtomicFailure(sql, /expense_type_accounting_default_ch_only/);
    await sql.close();
  }, 60_000);
});


// ─── T24: the drops ──────────────────────────────────────────────────────────

const MOVED_TABLES = [
  "ledger_account",
  "vat_code",
  "accounting_catalog_status",
  "expense_type_default",
  "exchange_rate_entry",
  "exchange_rate_fetch_attempt",
];

/** Everything about the structure that a migration can change, in a form two databases can be compared on. */
async function catalog(s: SQL) {
  return {
    columns: await rows(
      s,
      `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name <> '_prisma_migrations' ORDER BY table_name, column_name`,
    ),
    constraints: await rows(s, `SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint ORDER BY 1, 2`),
    indexes: await rows(s, `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2`),
    triggers: await rows(s, `SELECT tgrelid::regclass::text AS tbl, tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2`),
    functions: await rows(s, `SELECT proname, pg_get_functiondef(oid) AS def FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY 1`),
    types: await rows(
      s,
      `SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels FROM pg_type t LEFT JOIN pg_enum e ON e.enumtypid = t.oid
       WHERE t.typnamespace = 'public'::regnamespace AND t.typtype = 'e' GROUP BY t.typname ORDER BY 1`,
    ),
  };
}

const COPY_COLUMNS = [
  "id",
  "updatedAt",
  "entity",
  "currency",
  "ledgerAccountIsDefault",
  "vatCodeIsDefault",
  "accountNumber",
  "accountName",
  "vatCode",
  "vatRateBasisPoints",
  "fxRateMicros",
  "fxRateMonth",
  "fxRateCopiedAt",
  "receiptNumber",
  "receiptOwnerUserId",
  "receiptYear",
  "receiptSeq",
  "numberedAt",
  "approvedTotalCents",
  "rejectionReason",
];
const lineSnapshot = (s: SQL) => rows(s, `SELECT ${COPY_COLUMNS.map((c) => `"${c}"`).join(", ")} FROM refund_line ORDER BY id`);

describe("20261119130000_accounting_reference_moved_out, from a 20261118 database through both migrations", () => {
  let sql: SQL;
  let linesAtCopies: Row[];
  let catalogAtCopies: Awaited<ReturnType<typeof catalog>>;
  let counts: Record<string, number>;

  const TABLES_KEPT = [
    "refund_line",
    "refund_request",
    "refund_setting",
    "refund_audit_entry",
    "receipt_counter",
    "refund_batch_export",
    "expense_type_accounting_default",
    "foreign_currency_vat_designation",
  ];
  const countsOf = async (s: SQL) =>
    Object.fromEntries(await Promise.all(TABLES_KEPT.map(async (t) => [t, (await rows(s, `SELECT count(*)::int AS n FROM "${t}"`))[0]!.n as number])));

  beforeAll(async () => {
    sql = await scratch("refund_mig_t24");
    await apply(sql, BASE);
    await fixtures(sql);
    // Realistic odds and ends of the kept tables, so that "untouched" means something
    await insert(sql, "receipt_counter", { ownerUserId: "owner-1", year: 2026, lastSeq: 8, startAfter: 3, startAfterSetBy: "system:accounting-release", updatedAt: "2026-04-01T00:00:00.000" });
    await insert(sql, "refund_batch", { id: "b-1", cutoff: "2026-04-01T00:00:00.000", createdByUserId: "acct-1", createdByEmail: "acct-1@welld.ch", pdfObjectKey: "refund/batches/b-1/compiled.pdf", updatedAt: "2026-04-01T00:00:00.000" });
    await insert(sql, "refund_batch_export", { id: "exp-1", batchId: "b-1", actorUserId: "acct-1", actorEmail: "acct-1@welld.ch", rowCount: 3, excludedLineCount: 1, contentSha256: "a".repeat(64), formatVersion: 1 });
    await apply(sql, THIS, THIS);
    linesAtCopies = await lineSnapshot(sql);
    catalogAtCopies = await catalog(sql);
    counts = await countsOf(sql);
    await apply(sql, NEXT, NEXT);
  }, 60_000);

  it("is the migration that follows 20261119120000, back to back", () => {
    expect(migrationNames.indexOf(NEXT)).toBe(migrationNames.indexOf(THIS) + 1);
    expect(migrationNames[migrationNames.length - 1]).toBe(NEXT);
    expect(counts["refund_line"]).toBe(18);
    expect(counts["expense_type_accounting_default"]).toBe(5);
  });

  it("drops the six moved tables, the two old FK columns, their foreign keys and indexes, and the rate enum", async () => {
    const tables = (await rows(sql, `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).map((t) => t.tablename);
    for (const t of MOVED_TABLES) expect(tables).not.toContain(t);
    const cols = (await rows(sql, `SELECT column_name FROM information_schema.columns WHERE table_name = 'refund_line'`)).map((c) => c.column_name);
    expect(cols).not.toContain("ledgerAccountId");
    expect(cols).not.toContain("vatCodeId");
    const fks = (await rows(sql, `SELECT conname FROM pg_constraint WHERE contype = 'f'`)).map((c) => c.conname);
    expect(fks.filter((n) => /ledgerAccountId|vatCodeId/.test(n))).toEqual([]);
    const indexes = (await rows(sql, `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`)).map((i) => i.indexname);
    expect(indexes.filter((n) => /ledgerAccountId|vatCodeId|exchange_rate|ledger_account|vat_code|accounting_catalog|expense_type_default/.test(n))).toEqual([]);
    expect((await rows(sql, `SELECT count(*)::int AS n FROM pg_type WHERE typname = 'ExchangeRateOrigin'`))[0]!.n).toBe(0);
    // nothing of the dropped tables is left behind: no trigger, no CHECK named after them
    const left = await rows(
      sql,
      `SELECT conname AS name FROM pg_constraint WHERE conname ~ '^(ledger_account|vat_code|accounting_catalog_status|expense_type_default|exchange_rate_)'
       UNION ALL SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname ~ '^(ledger_account|vat_code|accounting_catalog_status|expense_type_default|exchange_rate_)'`,
    );
    expect(left).toEqual([]);
  });

  it("keeps what stays: every row of the kept tables, and for every line each copy, flag, number and time as before", async () => {
    expect(await countsOf(sql)).toEqual(counts);
    expect(await lineSnapshot(sql)).toEqual(linesAtCopies);
    // the carried history is intact, with its ids and actors
    const defaults = await rows(sql, `SELECT id, "createdByUserId", "accountNumber", "vatCode" FROM expense_type_accounting_default ORDER BY id`);
    expect(defaults.map((d) => [d.id, d.createdByUserId, d.accountNumber, d.vatCode])).toEqual([
      ["def-1", "admin-7", "5901", "IMP81"],
      ["def-2", "admin-7", "6101", "NOVAT"],
      ["def-3", "admin-8", "5901", "NOVAT"],
      ["def-4", "admin-7", "6101", null],
      ["def-5", "admin-7", null, "IMP81"],
    ]);
    // the immutable old designation rows stay in refund_setting, unread
    expect((await rows(sql, `SELECT count(*)::int AS n FROM refund_setting WHERE key = 'accounting.welld_ch.foreign-currency-vat-code'`))[0]!.n).toBe(4);
    // and the carried rate copies are the ones the rates dropped here produced
    const fx = await rows(sql, `SELECT id, "fxRateMicros" FROM refund_line WHERE "fxRateMicros" IS NOT NULL ORDER BY id`);
    expect(fx.map((l) => [l.id, l.fxRateMicros])).toEqual([
      ["L-eur", 931000],
      ["L-eur-feb28", 910000],
      ["L-eur-mar", 931000],
      ["L-eur-mar31", 931000],
      ["L-gbp", 1100000],
      ["L-usd", 870000],
    ]);
  });

  it("changes nothing else in the database: constraints, indexes, triggers and functions of the kept tables are as after 20261119120000", async () => {
    const now = await catalog(sql);
    const goneTable = (tbl: string) => MOVED_TABLES.includes(tbl.replace(/"/g, ""));
    const keep = <T extends Record<string, any>>(xs: T[], key: string) => xs.filter((x) => !goneTable(x[key]));
    expect(now.constraints).toEqual(keep(catalogAtCopies.constraints, "tbl").filter((c) => !/ledgerAccountId|vatCodeId/.test(c.conname)));
    expect(now.triggers).toEqual(keep(catalogAtCopies.triggers, "tbl"));
    expect(now.indexes).toEqual(keep(catalogAtCopies.indexes, "tablename").filter((i) => !/ledgerAccountId|vatCodeId/.test(i.indexname)));
    expect(now.functions).toEqual(catalogAtCopies.functions); // the guard and the raising function are not replaced
    expect(now.types).toEqual(catalogAtCopies.types.filter((t) => t.typname !== "ExchangeRateOrigin"));
    expect(now.columns).toEqual(
      keep(catalogAtCopies.columns, "table_name").filter((c) => !(c.table_name === "refund_line" && ["ledgerAccountId", "vatCodeId"].includes(c.column_name))),
    );
  });

  it("every CHECK on the kept tables is still there and validated; the raising function still serves the kept history tables", async () => {
    expect(await rows(sql, `SELECT conname FROM pg_constraint WHERE contype = 'c' AND NOT convalidated`)).toEqual([]);
    const checks = (await rows(sql, `SELECT conname FROM pg_constraint WHERE contype = 'c' AND conrelid = 'refund_line'::regclass`)).map((c) => c.conname);
    expect(checks).toEqual(
      expect.arrayContaining([
        "refund_line_account_copy_pair",
        "refund_line_vat_copy_pair",
        "refund_line_fx_all_or_none",
        "refund_line_classification_ch_only",
        "refund_line_receipt_all_or_none",
      ]),
    );
    await expect(sql.unsafe(`UPDATE expense_type_accounting_default SET "accountNumber" = '1' WHERE id = 'def-1'`)).rejects.toThrow(/append-only/);
    await expect(sql.unsafe(`DELETE FROM refund_batch_export WHERE id = 'exp-1'`)).rejects.toThrow(/append-only/);
  });

  // Mutates rows: own scratch database, so the other tests of this block do not depend on its order (D-5).
  it("the guard no longer references a dropped column: a non-accounting column of a paid numbered line can be updated", async () => {
    const own = await scratchAt("refund_mig_t24_guard", "next");
    try {
      const [paid] = await rows(own, `SELECT l."receiptNumber", q.status FROM refund_line l JOIN refund_request q ON q.id = l."requestId" WHERE l.id = 'L-chf'`);
      expect([paid!.status, paid!.receiptNumber]).toEqual(["paid", "MC26/001"]); // a paid, numbered line with copies
      const def = (await rows(own, `SELECT pg_get_functiondef('refund_line_accounting_guard'::regproc) AS def`))[0]!.def as string;
      expect(def).not.toMatch(/ledgerAccountId|vatCodeId/);
      await own.unsafe(`UPDATE refund_line SET "motivo" = 'edited after paid', "km" = 7 WHERE id = 'L-chf'`);
      expect((await rows(own, `SELECT motivo FROM refund_line WHERE id = 'L-chf'`))[0]!.motivo).toBe("edited after paid");
      // ... while the guard still refuses what it is for
      await expect(own.unsafe(`UPDATE refund_line SET "accountNumber" = '9999', "accountName" = 'x' WHERE id = 'L-chf'`)).rejects.toThrow(/locked/);
      await expect(own.unsafe(`UPDATE refund_line SET "vatCodeIsDefault" = NOT "vatCodeIsDefault" WHERE id = 'L-chf'`)).rejects.toThrow(/locked/);
      await expect(own.unsafe(`UPDATE refund_line SET "receiptSeq" = 99 WHERE id = 'L-chf'`)).rejects.toThrow(/immutable/);
      await expect(own.unsafe(`UPDATE refund_line SET "fxRateMicros" = 1 WHERE id = 'L-eur'`)).rejects.toThrow(/write-once/);
      await expect(own.unsafe(`DELETE FROM refund_line WHERE id = 'L-chf'`)).rejects.toThrow(/cannot be deleted/);
      // an unnumbered line is still freely classifiable and deletable, and a pending rate is still copied once
      await own.unsafe(`UPDATE refund_line SET "accountNumber" = '6101', "accountName" = 'Spese materiale ufficio' WHERE id = 'L-legacy-eur'`);
      await own.unsafe(`UPDATE refund_line SET "fxRateMicros" = 940000, "fxRateMonth" = '2026-04-01', "fxRateCopiedAt" = now() WHERE id = 'L-eur-pending-paid'`);
      await own.unsafe(`DELETE FROM refund_line WHERE id = 'L-draft'`);
    } finally {
      await own.close();
    }
  }, 60_000);

  it("an old table can no longer be written to or referenced by a new line", async () => {
    await expect(sql.unsafe(`INSERT INTO ledger_account (id) VALUES ('x')`)).rejects.toThrow(/ledger_account/);
    await expect(sql.unsafe(`UPDATE refund_line SET "ledgerAccountId" = 'acc-office' WHERE id = 'L-sub-hand'`)).rejects.toThrow(/ledgerAccountId/);
  });

  it("a fresh database applies every migration and ends with exactly the structure of the migrated one", async () => {
    const fresh = await scratch("refund_mig_t24_zero");
    await apply(fresh, NEXT);
    expect(await catalog(fresh)).toEqual(await catalog(sql));
    await fresh.close();
  }, 60_000);

  it("a migration run twice is refused by its own first statements, not half applied (it is one-way)", async () => {
    await expect(apply(sql, NEXT, NEXT)).rejects.toThrow();
  });
});

describe("20261119130000_accounting_reference_moved_out refuses, whole, to drop what the copies do not hold", () => {
  /** A database at 20261119120000 with the fixture, mutated the way an OLDER build would after that migration. */
  async function behind(name: string, mutate: (sql: SQL) => Promise<unknown>) {
    const sql = await scratch(name);
    await apply(sql, BASE);
    await fixtures(sql);
    await apply(sql, THIS, THIS);
    await mutate(sql);
    return sql;
  }

  async function expectNothingDropped(sql: SQL, message: RegExp) {
    await expect(apply(sql, NEXT, NEXT)).rejects.toThrow(message);
    const tables = (await rows(sql, `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).map((t) => t.tablename);
    for (const t of MOVED_TABLES) expect(tables).toContain(t);
    const cols = (await rows(sql, `SELECT column_name FROM information_schema.columns WHERE table_name = 'refund_line'`)).map((c) => c.column_name);
    expect(cols).toEqual(expect.arrayContaining(["ledgerAccountId", "vatCodeId"]));
    expect((await rows(sql, `SELECT count(*)::int AS n FROM pg_type WHERE typname = 'ExchangeRateOrigin'`))[0]!.n).toBe(1);
  }

  it("a line an older build classified after the copies migration, with no copy, is named", async () => {
    const sql = await behind("refund_mig_t24_odd1", (s) =>
      s.unsafe(`UPDATE refund_line SET "ledgerAccountId" = 'acc-office', "ledgerAccountIsDefault" = false WHERE id = 'L-sub-eur'`),
    );
    await expectNothingDropped(sql, /refund_line rows L-sub-eur reference the old catalog/);
    await sql.close();
  }, 60_000);

  it("a line with an old VAT code and no copy of it is named", async () => {
    const sql = await behind("refund_mig_t24_odd2", (s) =>
      s.unsafe(`UPDATE refund_line SET "vatCodeId" = 'vat-imp81', "vatCodeIsDefault" = false WHERE id = 'L-draft'`),
    );
    await expectNothingDropped(sql, /refund_line rows L-draft reference the old catalog/);
    await sql.close();
  }, 60_000);

  it("a default saved by an older build after the copies migration is named", async () => {
    const sql = await behind("refund_mig_t24_odd3", (s) =>
      insert(s, "expense_type_default", {
        id: "def-late",
        entity: "welld_ch",
        type: "postal",
        ledgerAccountId: "acc-office",
        vatCodeId: null,
        ...by(),
        createdAt: "2026-06-01T00:00:00.000",
      }),
    );
    await expectNothingDropped(sql, /expense_type_default rows def-late were not carried/);
    await sql.close();
  }, 60_000);

  it("a database that is only behind on copies the lines already hold is not refused (the check names only what would be lost)", async () => {
    const sql = await behind("refund_mig_t24_ok", (s) =>
      s.unsafe(`UPDATE refund_line SET "ledgerAccountId" = 'acc-train' WHERE id = 'L-sub-hand'`), // already has accountNumber 5901
    );
    await apply(sql, NEXT, NEXT);
    expect((await rows(sql, `SELECT "accountNumber" FROM refund_line WHERE id = 'L-sub-hand'`))[0]!.accountNumber).toBe("5901");
    await sql.close();
  }, 60_000);
});
