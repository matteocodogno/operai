/**
 * The three additive migrations of the accounting sign-off round, on data (T58,
 * specs/20261119-accounting; plan 20261118 § "Accounting sign-off delta (2026-11-19)" SO-1 and
 * SO-13, plan 20261119 SO-18 and risk R20; AC-8.1, AC-4.12, AC-4.7, AC-4.5; ADR
 * 20261119-data-that-moves-from-one-service-to-another-before-the-release-moves-by-an-additive-migration-...):
 *
 *   20261119200000_expense_types_flight_taxi
 *   20261119200100_receipt_number_baseline
 *   20261119200200_vat_defaults_retired
 *
 * Scratch databases `refund_mig_so*` on the same server as DATABASE_URL (never the test database
 * itself): built migration by migration from the files of `prisma/migrations` up to
 * `20261119130000_accounting_reference_moved_out`, filled with realistic fixture rows (the
 * defaults history with VAT halves, the designation history, classified lines of every status,
 * receipt counters, audit entries, a batch and its export log), then the new migrations are
 * applied. Each scratch database is removed at the end. Applied migrations are never edited: the
 * test reads the files and applies them as Prisma does (one multi-statement simple query each).
 *
 * `prisma migrate diff` (the CLI, through `node`) must find no difference between the schema file
 * and the database that these migrations produce, from zero and from the carried database.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const MIGRATIONS_DIR = join(ROOT, "prisma/migrations");
const BEFORE = "20261119130000_accounting_reference_moved_out";
const M_ENUM = "20261119200000_expense_types_flight_taxi";
const M_BASELINE = "20261119200100_receipt_number_baseline";
const M_VAT = "20261119200200_vat_defaults_retired";

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
  expect(name).toMatch(/^refund_mig_so[a-z0-9_]*$/); // never anything but a scratch name of this file
  await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${name}`);
  created.add(name);
  return new SQL(urlOf(name), { max: 1 });
}

afterAll(async () => {
  for (const name of created) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.close();
}, 60_000);

type Row = Record<string, any>;
const rows = async (sql: SQL, text: string, params: unknown[] = []): Promise<Row[]> => Array.from(await sql.unsafe(text, params as never[]));

async function insert(sql: SQL, table: string, row: Record<string, unknown>) {
  const cols = Object.keys(row);
  const text = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`;
  await sql.unsafe(text, Object.values(row) as never[]);
}

const by = (id = "admin-7") => ({ createdByUserId: id, createdByEmail: `${id}@welld.ch` });

// ─── Fixtures at the 20261119130000 schema ───────────────────────────────────

const DESIGNATION_KEY = "accounting.welld_ch.foreign-currency-vat-code";

/** Default history rows, with the VAT half the migration discards. */
const DEFAULTS: Row[] = [
  // a type with a full default, never changed
  { id: "def-km", type: "travel_km", accountNumber: "5905", accountName: "Spese rimborsi chilometrici", vatCode: "IMP81", vatLabel: "IVA 8.1%", vatRateBasisPoints: 810, who: "admin-7", at: "2026-03-01T09:00:00.000" },
  { id: "def-train", type: "travel_train", accountNumber: "5901", accountName: "Spese di viaggio: treno", vatCode: "IMP81", vatLabel: "IVA 8.1%", vatRateBasisPoints: 810, who: "admin-7", at: "2026-03-01T09:01:00.000" },
  // postal: account + 0 % code, then ONLY the VAT changes (the account repeats), then the account changes and the VAT is cleared
  { id: "def-postal-1", type: "postal", accountNumber: "6104", accountName: "Spese postali", vatCode: "NOVAT", vatLabel: "Senza IVA", vatRateBasisPoints: 0, who: "admin-7", at: "2026-03-02T09:00:00.000" },
  { id: "def-postal-2", type: "postal", accountNumber: "6104", accountName: "Spese postali", vatCode: "IMP81", vatLabel: "IVA 8.1%", vatRateBasisPoints: 810, who: "admin-8", at: "2026-03-03T09:00:00.000" },
  { id: "def-postal-3", type: "postal", accountNumber: "6101", accountName: "Spese materiale ufficio", vatCode: null, vatLabel: null, vatRateBasisPoints: null, who: "admin-7", at: "2026-03-04T09:00:00.000" },
  // account only, no VAT
  { id: "def-tel", type: "telephone", accountNumber: "6102", accountName: "Spese telefoniche", vatCode: null, vatLabel: null, vatRateBasisPoints: null, who: "admin-8", at: "2026-03-05T09:00:00.000" },
  // account numbers with a dot (2620.1 and 2620.10 are two different accounts)
  { id: "def-man", type: "company_manuals", accountNumber: "2620.1", accountName: "Altri debiti verso soci - CHF (CH)", vatCode: "IMP77", vatLabel: "IVA 7.7%", vatRateBasisPoints: 770, who: "admin-7", at: "2026-03-06T09:00:00.000" },
  { id: "def-man-2", type: "company_manuals", accountNumber: "2620.10", accountName: "Conto con zero finale", vatCode: null, vatLabel: null, vatRateBasisPoints: null, who: "admin-7", at: "2026-03-07T09:00:00.000" },
  // a VAT-only default (no account): after the migration it is an empty "no default" row, kept
  { id: "def-stat", type: "stationery", accountNumber: null, accountName: null, vatCode: "IMP81", vatLabel: "IVA 8.1%", vatRateBasisPoints: 810, who: "admin-7", at: "2026-03-08T09:00:00.000" },
  // cleared ("no default")
  { id: "def-gifts-1", type: "representation_gifts", accountNumber: "7122", accountName: "Spese da riaddebitare", vatCode: "NOVAT", vatLabel: "Senza IVA", vatRateBasisPoints: 0, who: "admin-7", at: "2026-03-09T09:00:00.000" },
  { id: "def-gifts-2", type: "representation_gifts", accountNumber: null, accountName: null, vatCode: null, vatLabel: null, vatRateBasisPoints: null, who: "admin-9", at: "2026-03-10T09:00:00.000" },
  // the 10000 bp boundary and an old VAT value that no longer maps to any code of the sign-off list
  { id: "def-meals", type: "representation_meals", accountNumber: "6701", accountName: "Spese pranzi e cene con clienti", vatCode: "ZZ100", vatLabel: "Cento per cento", vatRateBasisPoints: 10000, who: "admin-7", at: "2026-03-11T09:00:00.000" },
];

const DEFAULT_KEPT = ["id", "entity", "type", "accountNumber", "accountName", "createdByUserId", "createdByEmail", "createdAt"];

async function fixtures(sql: SQL) {
  for (const d of DEFAULTS) {
    await insert(sql, "expense_type_accounting_default", {
      id: d["id"],
      entity: "welld_ch",
      type: d["type"],
      accountNumber: d["accountNumber"],
      accountName: d["accountName"],
      vatCode: d["vatCode"],
      vatLabel: d["vatLabel"],
      vatRateBasisPoints: d["vatRateBasisPoints"],
      ...by(d["who"]),
      createdAt: d["at"],
    });
  }
  // designation history: set, changed, cleared, set again
  const des = (id: string, code: string | null, label: string | null, bp: number | null, who: string, at: string) =>
    insert(sql, "foreign_currency_vat_designation", { id, entity: "welld_ch", vatCode: code, vatLabel: label, vatRateBasisPoints: bp, ...by(who), createdAt: at });
  await des("des-1", "NOVAT", "Senza IVA", 0, "admin-7", "2026-03-01T10:00:00.000");
  await des("des-2", "IMP81", "IVA 8.1%", 810, "admin-8", "2026-03-02T10:00:00.000");
  await des("des-3", null, null, null, "admin-7", "2026-03-03T10:00:00.000");
  await des("des-4", "BZM81", "Reverse charge", 810, "admin-7", "2026-03-04T10:00:00.000");
  // refund_setting: the immutable designation rows (left unread, D33) and unrelated keys; all must survive
  const setting = (id: string, key: string, value: string | null, who: string, at: string) =>
    insert(sql, "refund_setting", { id, key, value, ...by(who), createdAt: at });
  await setting("set-1", DESIGNATION_KEY, "vat-old-1", "admin-7", "2026-02-01T00:00:00.000");
  await setting("set-2", DESIGNATION_KEY, null, "admin-7", "2026-02-02T00:00:00.000");
  await setting("set-x", "accounting-distribution-email", "accounting@welld.ch", "admin-7", "2026-03-01T00:00:00.000");
  await setting("set-y", "accounting-release-completed-at", "2026-03-01T00:00:00.000Z", "system:accounting-release", "2026-03-01T00:00:00.000");

  // requests and lines, every status; classified lines carry account and VAT copies
  const req = (id: string, status: string, owner: string) =>
    insert(sql, "refund_request", { id, ownerUserId: owner, ownerEmail: `${owner}@welld.ch`, status, updatedAt: "2026-04-01T00:00:00.000" });
  await req("rq-paid", "paid", "owner-1");
  await req("rq-appr", "approved", "owner-2");
  await req("rq-subm", "submitted", "owner-3");
  await req("rq-draft", "draft", "owner-4");
  await req("rq-it", "approved", "owner-5");

  interface L {
    id: string;
    request: string;
    date: string;
    type?: string;
    entity?: "welld_ch" | "welld_it";
    currency?: "CHF" | "EUR" | "USD" | "GBP";
    receipt?: number;
    account?: [string, string];
    vat?: [string, number];
    accountDefault?: boolean;
    vatDefault?: boolean;
    fx?: number;
  }
  const line = (l: L) =>
    insert(sql, "refund_line", {
      id: l.id,
      requestId: l.request,
      date: l.date,
      type: l.type ?? "office_material",
      motivo: `reason of ${l.id}`,
      entity: l.entity ?? "welld_ch",
      currency: l.currency ?? "CHF",
      requestedAmountCents: 12345,
      approvedTotalCents: 12345,
      updatedAt: "2026-04-01T07:00:00.000",
      accountNumber: l.account?.[0] ?? null,
      accountName: l.account?.[1] ?? null,
      ledgerAccountIsDefault: l.account ? (l.accountDefault ?? true) : null,
      vatCode: l.vat?.[0] ?? null,
      vatRateBasisPoints: l.vat?.[1] ?? null,
      vatCodeIsDefault: l.vat ? (l.vatDefault ?? true) : null,
      ...(l.fx ? { fxRateMicros: l.fx, fxRateMonth: `${l.date.slice(0, 7)}-01`, fxRateCopiedAt: "2026-04-05T09:00:00.000" } : {}),
      ...(l.receipt
        ? {
            receiptNumber: `MC26/${String(l.receipt).padStart(3, "0")}`,
            receiptOwnerUserId: `owner-of-${l.request}`,
            receiptYear: 2026,
            receiptSeq: l.receipt,
            numberedAt: "2026-04-01T08:00:00.000",
          }
        : {}),
    });
  const office: [string, string] = ["6101", "Spese materiale ufficio"];
  const train: [string, string] = ["5901", "Spese di viaggio: treno"];
  // paid and numbered: copies that came from a former VAT default (is-default = true) and by hand (false)
  await line({ id: "L-chf-default-vat", request: "rq-paid", date: "2026-03-02", receipt: 1, account: office, vat: ["IMP81", 810], accountDefault: true, vatDefault: true });
  await line({ id: "L-chf-hand-vat", request: "rq-paid", date: "2026-03-03", receipt: 2, account: train, vat: ["IP00", 0], accountDefault: false, vatDefault: false, type: "travel_train" });
  await line({ id: "L-eur", request: "rq-paid", date: "2026-03-10", currency: "EUR", receipt: 3, account: office, vat: ["NOVAT", 0], fx: 924600 });
  await line({ id: "L-usd-noVat", request: "rq-paid", date: "2026-03-11", currency: "USD", receipt: 4, account: train, fx: 880000 });
  // approved: account only (nothing pre-set), one classified through a former foreign-currency designation
  await line({ id: "L-appr-acc", request: "rq-appr", date: "2026-04-05", receipt: 1, account: office });
  await line({ id: "L-appr-gbp", request: "rq-appr", date: "2026-04-06", currency: "GBP", receipt: 2, account: train, vat: ["BZM81", 810], vatDefault: true, fx: 1100000 });
  // submitted and draft: copies of a hand classification, and nothing
  await line({ id: "L-sub-hand", request: "rq-subm", date: "2026-03-02", account: train, vat: ["IMP81", 810], accountDefault: false, vatDefault: false });
  await line({ id: "L-sub-bare", request: "rq-subm", date: "2026-03-12", currency: "EUR" });
  await line({ id: "L-draft", request: "rq-draft", date: "2026-03-14", currency: "EUR", account: office, accountDefault: false });
  // a WellD Italia line is never classified
  await line({ id: "L-it", request: "rq-it", date: "2026-03-02", entity: "welld_it", currency: "EUR" });

  // audit entries, including line_classified with a VAT code in its detail (history, never rewritten)
  const audit = (id: string, request: string, action: string, lineId: string | null, detail: unknown, at: string) =>
    insert(sql, "refund_audit_entry", {
      id,
      requestId: request,
      lineId,
      actorUserId: "admin-7",
      actorEmail: "admin-7@welld.ch",
      action,
      detail: detail === null ? null : JSON.stringify(detail),
      createdAt: at,
    });
  await audit("aud-1", "rq-paid", "line_classified", "L-chf-default-vat", { version: 2, vatCode: { from: null, to: "IMP81", fromDefault: false, toDefault: true } }, "2026-03-20T10:00:00.000");
  await audit("aud-2", "rq-paid", "receipt_number_assigned", "L-chf-default-vat", { receiptNumber: "MC26/001" }, "2026-03-20T10:01:00.000");
  await audit("aud-3", "rq-appr", "approved", null, null, "2026-04-02T10:00:00.000");

  // numbering: counters of 2025 and 2026, one started from an offset by the release script
  const counter = (owner: string, year: number, lastSeq: number, startAfter: number, setBy: string | null) =>
    insert(sql, "receipt_counter", { ownerUserId: owner, year, lastSeq, startAfter, startAfterSetBy: setBy, updatedAt: "2026-04-01T08:00:00.000" });
  await counter("owner-of-rq-paid", 2026, 4, 0, null);
  await counter("owner-of-rq-appr", 2026, 83, 81, "system:accounting-release");
  await counter("owner-of-rq-paid", 2025, 12, 0, null);

  // a batch and its export log
  await insert(sql, "refund_batch", {
    id: "batch-1",
    cutoff: "2026-04-01T00:00:00.000",
    ...by("acct-1"),
    pdfObjectKey: "refund/batches/batch-1/compiled.pdf",
    updatedAt: "2026-04-01T00:00:00.000",
  });
  await insert(sql, "refund_batch_export", {
    id: "exp-1",
    batchId: "batch-1",
    actorUserId: "acct-1",
    actorEmail: "acct-1@welld.ch",
    rowCount: 4,
    excludedLineCount: 1,
    contentSha256: "a".repeat(64),
    formatVersion: 1,
    createdAt: "2026-04-02T00:00:00.000",
  });
}

/** Tables the sign-off migrations change on purpose; every other table is digested in full. */
const CHANGED_ON_PURPOSE = new Set(["_prisma_migrations", "expense_type_accounting_default", "foreign_currency_vat_designation", "receipt_number_baseline"]);

type Digests = Record<string, { n: number; md5: string }>;
async function digests(sql: SQL): Promise<Digests> {
  const tables = (await rows(sql, `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`))
    .map((r) => r["table_name"] as string)
    .filter((t) => !CHANGED_ON_PURPOSE.has(t));
  const out: Digests = {};
  for (const t of tables) {
    const r = await rows(sql, `SELECT count(*)::int AS n, md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY to_jsonb(x)::text), '')) AS md5 FROM "${t}" x`);
    out[t] = { n: r[0]!["n"], md5: r[0]!["md5"] };
  }
  return out;
}

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
type Catalog = Awaited<ReturnType<typeof catalog>>;

const EXPENSE_TYPES_AFTER = [
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
];

const expenseTypeLabels = (c: Catalog) => c.types.find((t) => t["typname"] === "ExpenseType")!["labels"] as string;

/** `prisma migrate diff` from the database to the schema file: exit 0 and "No difference detected" when they agree. */
function prismaDiff(databaseUrl: string): { code: number; out: string } {
  const node = Bun.which("node");
  if (!node) throw new Error("`node` is not on PATH: the Prisma CLI (db:generate, migrate) needs it, so this test needs it too");
  const proc = Bun.spawnSync(
    [node, join(ROOT, "node_modules/prisma/build/index.js"), "migrate", "diff", "--from-config-datasource", "--to-schema", join(ROOT, "prisma/schema.prisma"), "--exit-code"],
    { cwd: ROOT, env: { ...process.env, DATABASE_URL: databaseUrl }, timeout: 90_000 },
  );
  return { code: proc.exitCode ?? -1, out: `${proc.stdout.toString()}${proc.stderr.toString()}` };
}

describe("the sign-off migrations carry a 20261119130000 database with realistic data", () => {
  let sql: SQL;
  let url: string;
  let before: { digests: Digests; defaults: Row[]; catalog: Catalog };

  beforeAll(async () => {
    sql = await scratch("refund_mig_so");
    url = urlOf("refund_mig_so");
    await apply(sql, BEFORE);
    await fixtures(sql);
    before = {
      digests: await digests(sql),
      defaults: await rows(sql, `SELECT ${DEFAULT_KEPT.map((c) => `"${c}"`).join(", ")} FROM expense_type_accounting_default ORDER BY "createdAt", id`),
      catalog: await catalog(sql),
    };
    await apply(sql, M_VAT, M_ENUM);
  }, 120_000);

  it("(control) the fixture is what the test says it is: 12 default rows, 4 designation rows, 10 lines", async () => {
    expect(before.defaults).toHaveLength(12);
    expect(before.digests["refund_line"]!.n).toBe(10);
    expect(before.catalog.triggers.filter((t) => t["tbl"] === "foreign_currency_vat_designation")).toHaveLength(2);
    expect(expenseTypeLabels(before.catalog)).not.toContain("travel_flight");
    // the designation rows existed on the carried database (this scratch database has since moved on)
    const fresh = await scratch("refund_mig_so_ctl");
    await apply(fresh, BEFORE);
    await fixtures(fresh);
    expect(await rows(fresh, `SELECT count(*)::int AS n FROM foreign_currency_vat_designation`)).toEqual([{ n: 4 }]);
    expect(await rows(fresh, `SELECT count(*)::int AS n FROM expense_type_accounting_default WHERE "vatCode" IS NOT NULL`)).toEqual([{ n: 8 }]);
    await fresh.close();
  }, 60_000);

  it("the designation table is gone, with its triggers; the shared raising function stays", async () => {
    expect((await rows(sql, `SELECT to_regclass('public.foreign_currency_vat_designation')::text AS t`))[0]!["t"]).toBeNull();
    expect(await rows(sql, `SELECT tgname FROM pg_trigger WHERE tgname LIKE 'foreign_currency_vat_designation%'`)).toEqual([]);
    expect(await rows(sql, `SELECT proname FROM pg_proc WHERE proname = 'accounting_history_immutable'`)).toHaveLength(1);
  });

  it("the defaults table lost the three VAT columns and the two VAT CHECKs, and nothing else", async () => {
    const after = await catalog(sql);
    const columns = (c: Catalog) => c.columns.filter((x) => x["table_name"] === "expense_type_accounting_default").map((x) => x["column_name"] as string);
    expect(columns(before.catalog).filter((c) => !columns(after).includes(c)).sort()).toEqual(["vatCode", "vatLabel", "vatRateBasisPoints"]);
    expect(columns(after).filter((c) => !columns(before.catalog).includes(c))).toEqual([]);
    expect(after.constraints.filter((c) => c["tbl"] === "expense_type_accounting_default").map((c) => c["conname"])).toEqual([
      "expense_type_accounting_default_account_pair",
      "expense_type_accounting_default_ch_only",
      "expense_type_accounting_default_pkey",
    ]);
    // the remaining columns keep their definitions; the index and the two append-only triggers stay
    const same = (c: Catalog) => c.columns.filter((x) => x["table_name"] === "expense_type_accounting_default" && !/^vat/.test(x["column_name"]));
    expect(same(after)).toEqual(same(before.catalog));
    const idx = (c: Catalog) => c.indexes.filter((x) => x["tablename"] === "expense_type_accounting_default");
    const trg = (c: Catalog) => c.triggers.filter((x) => x["tbl"] === "expense_type_accounting_default");
    expect(idx(after)).toEqual(idx(before.catalog));
    expect(trg(after)).toEqual(trg(before.catalog));
    expect(trg(after)).toHaveLength(2);
  });

  it("every default row keeps its id, entity, type, actor, time and account copy; the account history reads as before", async () => {
    const after = await rows(sql, `SELECT ${DEFAULT_KEPT.map((c) => `"${c}"`).join(", ")} FROM expense_type_accounting_default ORDER BY "createdAt", id`);
    expect(after).toEqual(before.defaults);
    expect(after).toHaveLength(12);
    // spot checks written by hand, not derived from the SQL under test
    const byId = Object.fromEntries(after.map((r) => [r["id"], r]));
    expect(byId["def-postal-2"]).toMatchObject({ accountNumber: "6104", accountName: "Spese postali", createdByUserId: "admin-8" }); // the row that once changed only the VAT now repeats the account
    expect(byId["def-man"]).toMatchObject({ accountNumber: "2620.1" });
    expect(byId["def-man-2"]).toMatchObject({ accountNumber: "2620.10" });
    expect(byId["def-stat"]).toMatchObject({ accountNumber: null, accountName: null }); // was VAT-only: an empty "no default" row, kept
    expect(byId["def-gifts-2"]).toMatchObject({ accountNumber: null, createdByUserId: "admin-9" });
    expect(byId["def-meals"]).toMatchObject({ accountNumber: "6701" });
    // current value per type = latest row, as the reader computes it
    const current = await rows(
      sql,
      `SELECT DISTINCT ON (type) type::text AS type, "accountNumber" FROM expense_type_accounting_default WHERE entity = 'welld_ch' ORDER BY type, "createdAt" DESC, id DESC`,
    );
    expect(Object.fromEntries(current.map((r) => [r["type"], r["accountNumber"]]))).toEqual({
      travel_km: "5905",
      travel_train: "5901",
      postal: "6101",
      telephone: "6102",
      company_manuals: "2620.10",
      stationery: null,
      representation_gifts: null,
      representation_meals: "6701",
    });
  });

  it("line copies, audit history, receipt counters, the designation rows of refund_setting, batches and every other table are unchanged", async () => {
    const after = await digests(sql);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before.digests).sort());
    expect(after).toEqual(before.digests);
    expect(after["refund_line"]!.n).toBe(10);
    expect(after["refund_setting"]!.n).toBe(4); // both designation rows and the two unrelated keys
    expect(after["receipt_counter"]!.n).toBe(3);
    expect(after["refund_audit_entry"]!.n).toBe(3);
    // the line copies that came from a former default still hold their VAT code (AC-5.3)
    const l = await rows(sql, `SELECT id, "vatCode", "vatRateBasisPoints", "vatCodeIsDefault" FROM refund_line WHERE "vatCode" IS NOT NULL ORDER BY id`);
    expect(l.map((r) => [r["id"], r["vatCode"], r["vatRateBasisPoints"], r["vatCodeIsDefault"]])).toEqual([
      ["L-appr-gbp", "BZM81", 810, true],
      ["L-chf-default-vat", "IMP81", 810, true],
      ["L-chf-hand-vat", "IP00", 0, false],
      ["L-eur", "NOVAT", 0, true],
      ["L-sub-hand", "IMP81", 810, false],
    ]);
  });

  it("the ExpenseType enum reads in the planned order; existing values and the lines that hold them are intact", async () => {
    const labels = await rows(sql, `SELECT enumlabel FROM pg_enum WHERE enumtypid = '"ExpenseType"'::regtype ORDER BY enumsortorder`);
    expect(labels.map((r) => r["enumlabel"])).toEqual(EXPENSE_TYPES_AFTER);
    expect(await rows(sql, `SELECT id FROM refund_line WHERE type = 'travel_train'`)).toEqual([{ id: "L-chf-hand-vat" }]);
  });

  it("the new enum values can be written after the migration (a line, a default)", async () => {
    for (const [i, type] of (["travel_flight", "travel_taxi"] as const).entries()) {
      await insert(sql, "refund_line", {
        id: `L-new-${type}`,
        requestId: "rq-draft",
        date: "2026-05-02",
        type,
        motivo: "m",
        entity: "welld_ch",
        currency: "CHF",
        requestedAmountCents: 100,
        updatedAt: "2026-05-01T00:00:00.000",
      });
      await insert(sql, "expense_type_accounting_default", {
        id: `def-new-${type}`,
        entity: "welld_ch",
        type,
        accountNumber: i === 0 ? "5902" : "5903",
        accountName: i === 0 ? "Spese viaggi in aereo" : "Spese viaggi taxi",
        ...by("admin-7"),
        createdAt: "2026-05-02T09:00:00.000",
      });
    }
    expect((await rows(sql, `SELECT type::text AS type FROM refund_line WHERE id LIKE 'L-new-%' ORDER BY id`)).map((r) => r["type"])).toEqual(["travel_flight", "travel_taxi"]);
  });

  it("receipt_number_baseline starts empty, takes a 2026 row and refuses a 2025 row and any UPDATE or DELETE", async () => {
    expect(await rows(sql, `SELECT count(*)::int AS n FROM receipt_number_baseline`)).toEqual([{ n: 0 }]);
    const row = { id: "bl-1", emailKey: "matteo.codogno@welld.ch", year: 2026, lastIssuedSeq: 81, ...by("system:accounting-release") };
    await insert(sql, "receipt_number_baseline", row);
    await expect(insert(sql, "receipt_number_baseline", { ...row, id: "bl-2", year: 2025 })).rejects.toThrow(/receipt_number_baseline_year_2026/);
    await expect(sql.unsafe(`UPDATE receipt_number_baseline SET "lastIssuedSeq" = 82 WHERE id = 'bl-1'`)).rejects.toThrow(/append-only/);
    await expect(sql.unsafe(`DELETE FROM receipt_number_baseline WHERE id = 'bl-1'`)).rejects.toThrow(/append-only/);
    expect(await rows(sql, `SELECT "lastIssuedSeq" FROM receipt_number_baseline`)).toEqual([{ lastIssuedSeq: 81 }]);
  });

  it("the guards of the other tables still hold (line paid lock, rate write-once, receipt, counter, defaults, export log, copy CHECKs)", async () => {
    await expect(sql.unsafe(`UPDATE refund_line SET "accountNumber" = '6102', "accountName" = 'x' WHERE id = 'L-chf-hand-vat'`)).rejects.toThrow(/locked/);
    await expect(sql.unsafe(`UPDATE refund_line SET "fxRateMicros" = 1 WHERE id = 'L-eur'`)).rejects.toThrow(/write-once/);
    await expect(sql.unsafe(`UPDATE refund_line SET "receiptNumber" = 'MC26/999' WHERE id = 'L-eur'`)).rejects.toThrow(/immutable/);
    await expect(sql.unsafe(`UPDATE receipt_counter SET "lastSeq" = 1 WHERE "ownerUserId" = 'owner-of-rq-appr' AND year = 2026`)).rejects.toThrow(/cannot decrease/);
    await expect(sql.unsafe(`UPDATE expense_type_accounting_default SET "accountNumber" = '1' WHERE id = 'def-km'`)).rejects.toThrow(/append-only/);
    await expect(sql.unsafe(`DELETE FROM refund_batch_export WHERE id = 'exp-1'`)).rejects.toThrow(/append-only/);
    await expect(sql.unsafe(`UPDATE refund_line SET "vatCode" = 'X' WHERE id = 'L-draft'`)).rejects.toThrow(/refund_line_vat_copy_pair/);
  });

  it("the database ends in the shape of schema.prisma: `prisma migrate diff` finds no difference", () => {
    const { code, out } = prismaDiff(url);
    expect(out).toContain("No difference detected");
    expect(code).toBe(0);
  }, 120_000);

  it("a fresh database applies every migration, ends with the same structure as the carried one, and `prisma migrate diff` is empty", async () => {
    const fresh = await scratch("refund_mig_so_zero");
    await apply(fresh, M_VAT);
    const a = await catalog(fresh);
    const b = await catalog(sql);
    expect(a.columns).toEqual(b.columns);
    expect(a.constraints).toEqual(b.constraints);
    expect(a.indexes).toEqual(b.indexes);
    expect(a.triggers).toEqual(b.triggers);
    expect(a.functions).toEqual(b.functions);
    expect(a.types).toEqual(b.types);
    expect(expenseTypeLabels(a)).toBe(EXPENSE_TYPES_AFTER.join(","));
    const { code, out } = prismaDiff(urlOf("refund_mig_so_zero"));
    expect(out).toContain("No difference detected");
    expect(code).toBe(0);
    await fresh.close();
  }, 180_000);
});

describe("each migration on its own, and when it cannot finish", () => {
  /** A database at 20261119130000 with the fixture rows. */
  async function carried(name: string) {
    const s = await scratch(name);
    await apply(s, BEFORE);
    await fixtures(s);
    return s;
  }

  it("20261119200000 alone changes only the enum: its order, and not one row or other object", async () => {
    const s = await carried("refund_mig_so_enum");
    const d0 = await digests(s);
    const defaults0 = await rows(s, `SELECT * FROM expense_type_accounting_default ORDER BY id`);
    const c0 = await catalog(s);
    await apply(s, M_ENUM, M_ENUM);
    expect(await digests(s)).toEqual(d0);
    expect(await rows(s, `SELECT * FROM expense_type_accounting_default ORDER BY id`)).toEqual(defaults0);
    const c1 = await catalog(s);
    expect({ ...c1, types: undefined }).toEqual({ ...c0, types: undefined });
    expect(expenseTypeLabels(c1)).toBe(EXPENSE_TYPES_AFTER.join(","));
    expect(c1.types.filter((t) => t["typname"] !== "ExpenseType")).toEqual(c0.types.filter((t) => t["typname"] !== "ExpenseType"));
    // the sort order of the enum (Settings and select order) follows the positions
    const sorted = await rows(
      s,
      `SELECT 'travel_other_public_transport'::"ExpenseType" < 'travel_flight'::"ExpenseType" AS a,
              'travel_flight'::"ExpenseType" < 'travel_taxi'::"ExpenseType" AS b,
              'travel_taxi'::"ExpenseType" < 'company_manuals'::"ExpenseType" AS c`,
    );
    expect(sorted).toEqual([{ a: true, b: true, c: true }]);
    await s.close();
  }, 60_000);

  it("20261119200100 alone adds one table with its index, three CHECKs and two triggers, and touches nothing else", async () => {
    const s = await carried("refund_mig_so_bl");
    const d0 = await digests(s);
    const c0 = await catalog(s);
    await apply(s, M_BASELINE, M_BASELINE);
    expect(await digests(s)).toEqual(d0);
    const c1 = await catalog(s);
    expect(
      c1.columns
        .filter((r) => r["table_name"] === "receipt_number_baseline")
        .map((r) => [r["column_name"], r["data_type"], r["is_nullable"]])
        .sort(),
    ).toEqual(
      [
        ["createdAt", "timestamp without time zone", "NO"],
        ["createdByEmail", "text", "NO"],
        ["createdByUserId", "text", "NO"],
        ["emailKey", "text", "NO"],
        ["id", "text", "NO"],
        ["lastIssuedSeq", "integer", "NO"],
        ["year", "integer", "NO"],
      ].sort(),
    );
    expect(c1.constraints.filter((r) => r["tbl"] === "receipt_number_baseline").map((r) => r["conname"])).toEqual([
      "receipt_number_baseline_email_key_lower",
      "receipt_number_baseline_pkey",
      "receipt_number_baseline_seq_range",
      "receipt_number_baseline_year_2026",
    ]);
    expect(c1.triggers.filter((r) => r["tbl"] === "receipt_number_baseline").map((r) => r["tgname"])).toEqual([
      "receipt_number_baseline_no_delete",
      "receipt_number_baseline_no_update",
    ]);
    const strip = (c: Catalog) => ({
      columns: c.columns.filter((r) => r["table_name"] !== "receipt_number_baseline"),
      constraints: c.constraints.filter((r) => r["tbl"] !== "receipt_number_baseline"),
      indexes: c.indexes.filter((r) => r["tablename"] !== "receipt_number_baseline"),
      triggers: c.triggers.filter((r) => r["tbl"] !== "receipt_number_baseline"),
      functions: c.functions,
      types: c.types,
    });
    expect(strip(c1)).toEqual(strip(c0));
    await s.close();
  }, 60_000);

  it("20261119200200 fails loudly, and whole, when something depends on a column it drops (no CASCADE)", async () => {
    const s = await carried("refund_mig_so_dep");
    // a view somebody made by hand on the VAT code of the defaults
    await s.unsafe(`CREATE VIEW someone_elses_report AS SELECT id, "vatCode" FROM expense_type_accounting_default`);
    await expect(apply(s, M_VAT, M_VAT)).rejects.toThrow(/someone_elses_report|depend/i);
    // one implicit transaction: the designation table and every column are still there, with their rows
    expect(await rows(s, `SELECT count(*)::int AS n FROM foreign_currency_vat_designation`)).toEqual([{ n: 4 }]);
    const cols = await rows(s, `SELECT column_name FROM information_schema.columns WHERE table_name = 'expense_type_accounting_default' AND column_name LIKE 'vat%' ORDER BY 1`);
    expect(cols.map((r) => r["column_name"])).toEqual(["vatCode", "vatLabel", "vatRateBasisPoints"]);
    expect(await rows(s, `SELECT conname FROM pg_constraint WHERE conname LIKE 'expense_type_accounting_default_vat_%' ORDER BY 1`)).toHaveLength(2);
    expect(await rows(s, `SELECT tgname FROM pg_trigger WHERE tgname LIKE 'foreign_currency_vat_designation%'`)).toHaveLength(2);
    await s.close();
  }, 60_000);

  it("20261119200200 applies cleanly on a database with no default and no designation rows (an empty developer database)", async () => {
    const s = await scratch("refund_mig_so_empty");
    await apply(s, M_VAT);
    expect(await rows(s, `SELECT count(*)::int AS n FROM expense_type_accounting_default`)).toEqual([{ n: 0 }]);
    expect((await rows(s, `SELECT to_regclass('public.foreign_currency_vat_designation')::text AS t`))[0]!["t"]).toBeNull();
    await s.close();
  }, 60_000);
});
