/**
 * Refund references Accounting by NATURAL key, so what it recorded survives Accounting entering its data again (T25,
 * specs/20261119-accounting; D1; AC-4.5, AC-4.7, AC-5.1, AC-5.3, AC-5.4, AC-7.4; plan § Test strategy row "Natural keys survive
 * re-entry": "Defaults saved; the fake's entries get new internal ids (not on the wire) -> defaults still resolve").
 *
 * The plan's rationale (D1): an account's number and a VAT code's code are the identity the spec gives them, immutable and the
 * words people use; a surrogate id "breaks on every re-entry" (an environment's data is entered again). So Refund stores the
 * number and the code, with a COPY of the name, label and rate, and never an id.
 *
 * The peer here is a small Accounting DIRECTORY with surrogate ids, behind the REAL client and its wire schemas (an injected
 * `fetch`; no socket). It projects entries to the reader's shape (no ids, as the producer's `GET /system/v1/...`), and it can:
 *   - `renumber()`: every entry gets a new internal id, and the entries come back in another order (a restore, a re-seed);
 *   - `leave(number)` and `enter(number, name)`: the entry disappears and is entered again later, under a new id and maybe a new
 *     name (the number is the same: it is the identity), with the gap in between;
 *   - hold look-alikes: `06101` beside `6101`, `imp81` beside `IMP81`, an entry only WellD Italia has under a number WellD CH also
 *     uses, so that a lookup by anything but the exact key of WellD CH would answer with the wrong entry.
 *
 * Proven: saved defaults and the designation still resolve (and are shown as active) after re-entry; a default books Accounting's
 * entry AS IT IS when approved (the new name), a copy a person chose keeps the name it was chosen with; approved lines, the view
 * and the export file are byte-identical across re-entry; a gap in Accounting is a refusal that names the lines (never a 5xx),
 * and ends when the entry is back; the exact key decides (no trimming of look-alikes, no case folding, no numeric equality);
 * WellD Italia is never read; the release seeds the same by natural key; and no id of Accounting is anywhere in Refund's rows or
 * answers, while an Accounting that WOULD send an id is refused rather than trusted.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { ResolveResponse } from "../authz/resolveClient";
import { truncateRefundTables } from "../test-support/dbCleanup";
import { setupTestAuth } from "../test-support/testAuth";

process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = "http://localhost:3001/auth/jwks";
process.env["AUTH_ISSUER"] = "http://localhost:3001";
process.env["AUTH_BASE_URL"] = "http://localhost:3001";
process.env["AUTH_AUDIENCE"] = "operai-suite";
process.env["NODE_ENV"] = "test";
process.env["NOTIFY_INTERNAL_URL"] = "http://localhost:8081";
process.env["ACCOUNTING_INTERNAL_URL"] = "http://localhost:8089";
process.env["SERVICE_CLIENT_ID"] = "refund-api";
process.env["SERVICE_CLIENT_SECRET"] = "test-service-client-secret-at-least-32-characters";
process.env["REFUND_S3_ENDPOINT"] = "https://test.s3.railway-eu-amsterdam.example.com";
process.env["REFUND_S3_REGION"] = "auto";
process.env["REFUND_S3_EU_ENDPOINT_HOSTS"] = "s3.railway-eu-amsterdam.example.com";
process.env["REFUND_S3_BUCKET"] = "test-bucket";
process.env["REFUND_S3_ACCESS_KEY_ID"] = "test-key";
process.env["REFUND_S3_SECRET_ACCESS_KEY"] = "test-secret";
process.env["REFUND_APP_BASE_URL"] = "http://localhost:5173";

const harness = setupTestAuth();
await harness.init();

// A query suffix gives each router a module instance of this file alone (testAuth.ts, "no shared router specifier").
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { decideRouter } = (await import("../review/decide.routes?natural-keys")) as typeof import("../review/decide.routes");
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { classificationRouter } = (await import("./classification.routes?natural-keys")) as typeof import("./classification.routes");
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { defaultsRouter } = (await import("./defaults.routes?natural-keys")) as typeof import("./defaults.routes");
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { createExportRouter } = (await import("./export.routes?natural-keys")) as typeof import("./export.routes");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { createAccountingClient } = await import("./accountingClient");
const { restoreAccounting, useFakeAccounting } = await import("../test-support/fakeAccounting");
const { runAccountingRelease } = await import("../../scripts/accounting-release");
const { notifyTransport } = await import("../lib/notifyPost");

const exportRouter = createExportRouter();

const realTokens = notifyTransport.tokens;
notifyTransport.tokens = { async getToken() { return "stub-service-jwt"; }, invalidate() {} };
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (typeof url === "string" && url.includes("/system/")) return new Response(JSON.stringify({ id: "n1" }), { status: 200 });
  return originalFetch(url, init);
}) as unknown as typeof fetch;

// ─── The directory: Accounting with internal ids ─────────────────────────────

interface AccountRow {
  id: string;
  number: string;
  name: string;
  active: boolean;
}
interface VatRow {
  id: string;
  code: string;
  label: string;
  rateBasisPoints: number;
  active: boolean;
}

const ID_PREFIX = "acc-id-";
class Directory {
  private counter = 1000;
  accounts: AccountRow[] = [];
  vatCodes: VatRow[] = [];
  /** WellD Italia's own accounts: the same numbers may exist there, under other names. */
  italianAccounts: AccountRow[] = [];
  rates = new Map<string, number>();
  /** Every entity named in a request path since the last `reset()`. */
  entitiesAsked = new Set<string>();
  /** Reads answer with the entries in a different order each time. */
  shuffleReads = false;
  /** A producer that (wrongly) sends its internal ids. */
  sendIds = false;

  reset(): void {
    this.counter = 1000;
    this.entitiesAsked = new Set();
    this.shuffleReads = false;
    this.sendIds = false;
    this.accounts = [];
    this.vatCodes = [];
    this.italianAccounts = [];
    this.addAccount("5901", "Treno");
    this.addAccount("6101", "Ufficio");
    this.addVat("IMP81", "IVA 8.1%", 810);
    this.addVat("NOVAT", "Senza IVA", 0);
    this.addVat("IMP77", "IVA 7.7%", 770);
    this.rates = new Map([["EUR:2026-03", 924_600]]);
  }
  private id(): string {
    return `${ID_PREFIX}${++this.counter}-${crypto.randomUUID().slice(0, 8)}`;
  }
  addAccount(number: string, name: string, active = true): void {
    this.accounts.push({ id: this.id(), number, name, active });
  }
  addVat(code: string, label: string, rateBasisPoints: number, active = true): void {
    this.vatCodes.push({ id: this.id(), code, label, rateBasisPoints, active });
  }
  addItalianAccount(number: string, name: string): void {
    this.italianAccounts.push({ id: this.id(), number, name, active: true });
  }
  /** A restore: the same natural keys with new ids, in another order. */
  renumber(): void {
    const again = <T extends { id: string }>(rows: T[]): T[] => rows.map((row) => ({ ...row, id: this.id() })).reverse();
    this.accounts = again(this.accounts);
    this.vatCodes = again(this.vatCodes);
    this.italianAccounts = again(this.italianAccounts);
  }
  /** The entry is gone (SA-3: not listed at all). */
  leave(number: string): void {
    this.accounts = this.accounts.filter((a) => a.number !== number);
  }
  leaveVat(code: string): void {
    this.vatCodes = this.vatCodes.filter((v) => v.code !== code);
  }
  /** Entered again: a new row, a new id, the same number, maybe another name. */
  enter(number: string, name: string): void {
    this.addAccount(number, name);
  }
  setActive(number: string, active: boolean): void {
    for (const a of this.accounts) if (a.number === number) a.active = active;
  }
  setVatActive(code: string, active: boolean): void {
    for (const v of this.vatCodes) if (v.code === code) v.active = active;
  }

  /** The reader's projection (AC-3.8, D18): no ids. */
  referenceData(entity: string) {
    const order = <T>(rows: T[]): T[] => (this.shuffleReads ? [...rows].sort(() => Math.random() - 0.5) : rows);
    const accounts = entity === "welld_it" ? this.italianAccounts : this.accounts;
    const projection = {
      entity,
      ownCurrency: entity === "welld_it" ? "EUR" : "CHF",
      ledgerAccounts: order(accounts).map((a) => ({ ...(this.sendIds ? { id: a.id } : {}), number: a.number, name: a.name, active: a.active })),
      vatCodes: entity === "welld_it" ? [] : order(this.vatCodes).map((v) => ({ code: v.code, label: v.label, rateBasisPoints: v.rateBasisPoints, active: v.active })),
    };
    return projection;
  }
  ratesFor(entity: string, pairs: string[]) {
    return {
      entity,
      rates: pairs.map((pair) => {
        const [currency, month] = pair.split(":");
        const rateMicros = this.rates.get(pair);
        return rateMicros !== undefined
          ? { currency, month, status: "in_effect", rateMicros, origin: "fetched", attempted: false }
          : { currency, month, status: "missing", attempted: false, reason: "not_published" };
      }),
    };
  }
}
const directory = new Directory();

const peerFetch = (async (input: unknown): Promise<Response> => {
  const url = new URL(String(input));
  const entity = url.pathname.split("/")[4] ?? "";
  directory.entitiesAsked.add(entity);
  if (url.pathname.endsWith("/rates")) {
    return Response.json(directory.ratesFor(entity, (url.searchParams.get("pairs") ?? "").split(",").filter(Boolean)));
  }
  return Response.json(directory.referenceData(entity));
}) as unknown as typeof fetch;

const port = createAccountingClient({
  baseUrl: "http://accounting.test:8089",
  fetchImpl: peerFetch,
  tokens: { async getToken() { return "svc-token"; }, invalidate() {} },
  deadlineMs: 2_000,
});

// ─── Harness ─────────────────────────────────────────────────────────────────

const OPERATOR: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [
    { resource: "refund", action: "access", conditions: null },
    { resource: "request", action: "review", conditions: null },
    { resource: "request", action: "set-approved-total", conditions: null },
    { resource: "request", action: "approve", conditions: null },
    { resource: "request", action: "reclassify", conditions: null },
    { resource: "settings", action: "read", conditions: null },
    { resource: "settings", action: "manage", conditions: null },
  ],
  entity: null,
  jobTitle: null,
};

type Router = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
interface Out {
  status: number;
  body: any;
  headers: Headers;
}
/** Every answer Refund gave in a test, as text: scanned at the end for an id of Accounting. */
let answers: string[] = [];
async function call(router: Router, method: string, path: string, body?: unknown): Promise<Out> {
  __resetAuthzCacheForTests();
  harness.setResolve(async () => OPERATOR);
  const token = await harness.signToken({ sub: "acct-1", email: "acct-1@welld.ch" });
  const res = await router.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  answers.push(text);
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    /* a CSV */
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

const saveDefault = (type: string, account: string | null, vat: string | null) =>
  call(defaultsRouter, "PUT", `/accounting/expense-type-defaults/${type}`, { accountNumber: account, vatCode: vat });
const designate = (vat: string | null) => call(defaultsRouter, "PUT", "/accounting/foreign-currency-vat-code", { vatCode: vat });
const getDefaults = () => call(defaultsRouter, "GET", "/accounting/expense-type-defaults");
const approve = (id: string) => call(decideRouter, "POST", `/review/requests/${id}/approve`);
const view = (id: string) => call(classificationRouter, "GET", `/review/requests/${id}/accounting`);
const classify = (id: string, lineId: string, body: unknown) =>
  call(classificationRouter, "PUT", `/review/requests/${id}/lines/${lineId}/classification`, body);
const options = () => call(classificationRouter, "GET", "/accounting/options");
const typeRow = (out: Out, type: string) => out.body.types.find((t: any) => t.type === type);

let seq = 0;
interface LineSpec {
  date?: string;
  type?: "travel_train" | "office_material" | "stationery" | "postal";
  currency?: "CHF" | "EUR";
  stored?: Record<string, unknown>;
}
async function createRequest(lines: LineSpec[]) {
  const owner = `owner-${++seq}`;
  const request = await db.refundRequest.create({
    data: { ownerUserId: owner, ownerEmail: `${owner}@welld.ch`, ownerName: "Matteo Codogno", status: "submitted", submittedAt: new Date() },
  });
  const ids: string[] = [];
  for (const [i, spec] of lines.entries()) {
    const line = await db.refundLine.create({
      data: {
        requestId: request.id,
        date: new Date(spec.date ?? "2026-03-02"),
        type: spec.type ?? "travel_train",
        motivo: "m",
        entity: "welld_ch",
        currency: spec.currency ?? "CHF",
        requestedAmountCents: 1040,
        createdAt: new Date(Date.UTC(2026, 2, 5, 10, 0, i)),
        ...(spec.stored ?? {}),
      },
    });
    ids.push(line.id);
  }
  return { id: request.id, lineIds: ids };
}
const lineOf = (id: string) => db.refundLine.findUniqueOrThrow({ where: { id } });

/** A compiled batch holding the (approved) request, so that it can be exported. */
async function batchWith(requestId: string) {
  const batch = await db.refundBatch.create({
    data: { cutoff: new Date("2026-03-31T21:59:59.000Z"), status: "compiled", createdByUserId: "a", createdByEmail: "a@x", pdfObjectKey: `refund/batches/${crypto.randomUUID()}/compiled.pdf` },
  });
  await db.refundRequest.update({ where: { id: requestId }, data: { batchId: batch.id } });
  await db.refundBatchItem.create({ data: { batchId: batch.id, requestId } });
  return batch.id;
}

/** Everything Refund stores about accounting, as text. */
async function refundRowsAsText(): Promise<string> {
  return JSON.stringify({
    lines: await db.refundLine.findMany(),
    defaults: await db.expenseTypeAccountingDefault.findMany(),
    designations: await db.foreignCurrencyVatDesignation.findMany(),
    audit: await db.refundAuditEntry.findMany(),
    exports: await db.refundBatchExport.findMany(),
    settings: await db.refundSetting.findMany(),
  });
}

let warn: ReturnType<typeof spyOn>;
beforeEach(async () => {
  directory.reset();
  answers = [];
  useFakeAccounting(port);
  await truncateRefundTables();
  warn = spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());
afterAll(async () => {
  restoreAccounting();
  await truncateRefundTables();
  notifyTransport.tokens = realTokens;
  globalThis.fetch = originalFetch;
});

// ═════════════════════════════════════════════════════════════════════════════

describe("saved defaults still resolve when Accounting enters its data again (D1)", () => {
  it("every entry gets a new internal id and comes back in another order: the defaults, the designation and the options are the same", async () => {
    expect((await saveDefault("travel_train", "5901", "IMP81")).status).toBe(200);
    expect((await saveDefault("office_material", "6101", "NOVAT")).status).toBe(200);
    expect((await designate("NOVAT")).status).toBe(200);
    const before = await getDefaults();
    const optionsBefore = await options();

    directory.renumber();
    directory.shuffleReads = true;

    for (let i = 0; i < 4; i++) {
      const after = await getDefaults();
      expect(after.status).toBe(200);
      expect(after.body).toEqual(before.body); // numbers, names, codes, labels, rates, states, history, timestamps: all the same
      expect(typeRow(after, "travel_train").account).toEqual({ number: "5901", name: "Treno", state: "active" });
      expect(typeRow(after, "office_material").vatCode).toMatchObject({ code: "NOVAT", state: "active" });
      expect(after.body.foreignCurrencyVatCodeUsable).toBe(true);
      expect((await options()).body).toEqual(optionsBefore.body); // offered in one stable order, whatever order Accounting answers in
    }
  });

  it("a request on the defaults is viewed and approved after the re-entry: the lines book the same number, code and rate", async () => {
    await saveDefault("travel_train", "5901", "IMP81");
    await saveDefault("office_material", "6101", "NOVAT");
    await designate("NOVAT");
    directory.renumber();

    const r = await createRequest([{ type: "travel_train" }, { type: "office_material", currency: "EUR", date: "2026-03-03" }]);
    const v = await view(r.id);
    expect(v.body.accounting).toBe("available");
    expect(v.body.lines[0].classification).toMatchObject({ account: { number: "5901", state: "active" }, accountIsDefault: true, vatCode: { code: "IMP81", state: "active" } });
    expect(v.body.lines[1].classification).toMatchObject({ account: { number: "6101", state: "active" }, vatCode: { code: "NOVAT", state: "active" } });

    expect((await approve(r.id)).status).toBe(200);
    expect(await lineOf(r.lineIds[0]!)).toMatchObject({ accountNumber: "5901", accountName: "Treno", vatCodeCopy: "IMP81", vatRateBasisPoints: 810, ledgerAccountIsDefault: true });
    expect(await lineOf(r.lineIds[1]!)).toMatchObject({ accountNumber: "6101", vatCodeCopy: "NOVAT", vatRateBasisPoints: 0, fxRateMicros: 924_600 });
  });

  it("a person's classification by number works across the re-entry, and copies the entry as it is then", async () => {
    const r = await createRequest([{ type: "stationery" }, { type: "stationery" }]);
    expect((await classify(r.id, r.lineIds[0]!, { accountNumber: "6101", vatCode: "IMP77" })).status).toBe(200);
    directory.renumber();
    directory.leave("6101");
    directory.enter("6101", "Ufficio (rientrato)"); // another row, another id, another name: the same number
    const second = await classify(r.id, r.lineIds[1]!, { accountNumber: "6101", vatCode: "IMP77" });
    expect(second.status).toBe(200);
    expect(await lineOf(r.lineIds[0]!)).toMatchObject({ accountNumber: "6101", accountName: "Ufficio", vatCodeCopy: "IMP77", vatRateBasisPoints: 770 });
    expect(await lineOf(r.lineIds[1]!)).toMatchObject({ accountNumber: "6101", accountName: "Ufficio (rientrato)", vatCodeCopy: "IMP77", vatRateBasisPoints: 770 });
  });
});

describe("what was booked does not move when Accounting enters its data again (AC-5.3, AC-5.4, AC-4.7)", () => {
  it("the approved lines, the view and the export file are byte-for-byte the same after a re-entry with other names and another rate", async () => {
    await saveDefault("travel_train", "5901", "IMP81");
    await saveDefault("office_material", "6101", "NOVAT");
    await designate("NOVAT");
    const r = await createRequest([{ type: "travel_train" }, { type: "office_material", currency: "EUR", date: "2026-03-03" }]);
    expect((await approve(r.id)).status).toBe(200);
    const batchId = await batchWith(r.id);
    const viewBefore = await view(r.id);
    const csvBefore = await call(exportRouter, "GET", `/batches/${batchId}/accounting-export/csv`);
    expect(csvBefore.status).toBe(200);
    const linesBefore = JSON.stringify(await Promise.all(r.lineIds.map(lineOf)));

    // Accounting enters everything again: new ids, other names, a corrected rate, the old entries gone for a while.
    directory.renumber();
    directory.leave("5901");
    directory.leave("6101");
    directory.leaveVat("IMP81");
    directory.enter("5901", "Treno e autobus");
    directory.enter("6101", "Materiale d'ufficio");
    directory.addVat("IMP81", "IVA 8.1% (nuova)", 810);
    directory.rates.set("EUR:2026-03", 930_000);

    expect(JSON.stringify(await Promise.all(r.lineIds.map(lineOf)))).toBe(linesBefore);
    const viewAfter = await view(r.id);
    expect(viewAfter.body.lines.map((l: any) => [l.classification.account.number, l.classification.account.name, l.classification.vatCode.code, l.chf])).toEqual(
      viewBefore.body.lines.map((l: any) => [l.classification.account.number, l.classification.account.name, l.classification.vatCode.code, l.chf]),
    );
    const csvAfter = await call(exportRouter, "GET", `/batches/${batchId}/accounting-export/csv`);
    expect(csvAfter.status).toBe(200);
    expect(csvAfter.body).toBe(csvBefore.body); // AC-5.4: the same bytes
    expect(csvAfter.body).toContain("0.9246"); // the copied rate, not the corrected one (AC-5.5)
    expect(csvAfter.body).not.toContain("0.9300");

    // AC-4.7: the history reads the same whatever happened in Accounting.
    const history = typeRow(await getDefaults(), "travel_train").history;
    expect(history).toHaveLength(1);
    expect(history[0].account).toEqual({ number: "5901", name: "Treno" });
  });
});

describe("a gap in Accounting, and the entry entered again (SA-3, AC-6.3)", () => {
  it("while an entry is not there the default is `not_found` and an approval names the line; once it is entered again the default works, with the entry as it is now", async () => {
    await saveDefault("travel_train", "5901", "IMP81");
    directory.leave("5901");
    const r = await createRequest([{ type: "travel_train" }]);

    const v = await view(r.id);
    expect(v.status).toBe(200);
    expect(v.body.lines[0].classification.account).toMatchObject({ number: "5901", state: "not_found" }); // reported, never `null`
    expect(typeRow(await getDefaults(), "travel_train").account).toMatchObject({ number: "5901", state: "not_found" });
    const refused = await approve(r.id);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("classification_missing");
    expect(refused.body.lines).toEqual([expect.objectContaining({ lineId: r.lineIds[0], missing: ["account"] })]);
    expect(await lineOf(r.lineIds[0]!)).toMatchObject({ accountNumber: null, receiptNumber: null });

    directory.renumber();
    directory.enter("5901", "Treno (rientrato)");
    expect(typeRow(await getDefaults(), "travel_train").account).toMatchObject({ number: "5901", state: "active" });
    expect((await approve(r.id)).status).toBe(200);
    expect(await lineOf(r.lineIds[0]!)).toMatchObject({ accountNumber: "5901", accountName: "Treno (rientrato)", ledgerAccountIsDefault: true });
    // The history keeps what was saved, in the words it was saved in.
    expect(typeRow(await getDefaults(), "travel_train").history[0].account).toEqual({ number: "5901", name: "Treno" });
  });

  it("a copy a person chose is booked as chosen, whether its entry is missing, entered again or renamed", async () => {
    await saveDefault("travel_train", "5901", "IMP81");
    const chosen = { accountNumber: "6101", accountName: "Ufficio (as chosen)", ledgerAccountIsDefault: false };

    directory.leave("6101");
    const during = await createRequest([{ type: "travel_train", stored: chosen }]);
    expect((await approve(during.id)).status).toBe(200); // the gap does not refuse a line that holds its own copy (AC-1.4 of 20261118)
    expect(await lineOf(during.lineIds[0]!)).toMatchObject({ accountNumber: "6101", accountName: "Ufficio (as chosen)", vatCodeCopy: "IMP81" });

    directory.enter("6101", "Ufficio (rientrato)");
    const after = await createRequest([{ type: "travel_train", stored: chosen }]);
    expect((await approve(after.id)).status).toBe(200);
    expect(await lineOf(after.lineIds[0]!)).toMatchObject({ accountNumber: "6101", accountName: "Ufficio (as chosen)", ledgerAccountIsDefault: false });
  });

  it("deactivated and reactivated, across a re-entry: the default is `deactivated` and unusable, then `active` and usable", async () => {
    await saveDefault("travel_train", "5901", "IMP81");
    await designate("NOVAT");
    const r = await createRequest([{ type: "travel_train", currency: "EUR" }]);
    directory.setActive("5901", false);
    directory.setVatActive("NOVAT", false);
    expect(typeRow(await getDefaults(), "travel_train").account).toMatchObject({ state: "deactivated" });
    expect((await getDefaults()).body.foreignCurrencyVatCodeUsable).toBe(false);
    expect((await approve(r.id)).status).toBe(409);
    expect((await options()).body.ledgerAccounts.map((a: any) => a.number)).toEqual(["6101"]);

    directory.renumber();
    directory.setActive("5901", true);
    directory.setVatActive("NOVAT", true);
    expect(typeRow(await getDefaults(), "travel_train").account).toMatchObject({ state: "active" });
    expect((await getDefaults()).body.foreignCurrencyVatCodeUsable).toBe(true);
    expect((await approve(r.id)).status).toBe(200);
  });
});

describe("the exact natural key decides, and only WellD CH's", () => {
  beforeEach(() => {
    directory.addAccount("06101", "Ufficio con lo zero");
    directory.addVat("imp81", "iva minuscola", 123);
    directory.addItalianAccount("6101", "Ufficio IT");
    directory.addItalianAccount("7777", "Solo Italia");
  });

  it("`6101` is not `06101`, `IMP81` is not `imp81`, and a number is not its numeric value", async () => {
    expect((await saveDefault("stationery", "6101", "IMP81")).body).toMatchObject({ account: { number: "6101", name: "Ufficio" }, vatCode: { code: "IMP81", ratePercent: "8.1" } });
    expect((await saveDefault("postal", "06101", "imp81")).body).toMatchObject({ account: { number: "06101", name: "Ufficio con lo zero" }, vatCode: { code: "imp81", label: "iva minuscola" } });
    for (const lookalike of ["6101.0", "61010", "６１０１", "0006101", "6101​"]) {
      const out = await saveDefault("telephone", lookalike, null);
      expect(out.status).toBe(422);
      expect(out.body.code).toBe("ledger_account_not_found");
    }
    for (const lookalike of ["Imp81", "IMP 81", "IMP81x"]) {
      const out = await saveDefault("telephone", null, lookalike);
      expect(out.status).toBe(422);
      expect(out.body.code).toBe("vat_code_not_found");
    }
    expect((await db.expenseTypeAccountingDefault.count({ where: { type: "telephone" } })).valueOf()).toBe(0);
    // Whitespace around a key the person typed is trimmed by the request schema (a typing slip, not a different entry).
    expect((await saveDefault("telephone", " 6101 ", " NOVAT ")).body).toMatchObject({ account: { number: "6101" }, vatCode: { code: "NOVAT" } });
  });

  it("both look-alikes are offered, as two entries, in one stable order whatever order Accounting answers in", async () => {
    const orders = new Set<string>();
    directory.shuffleReads = true;
    for (let i = 0; i < 6; i++) orders.add(JSON.stringify((await options()).body));
    expect(orders.size).toBe(1);
    const body = JSON.parse([...orders][0]!);
    expect(body.ledgerAccounts.map((a: any) => a.number).sort()).toEqual(["06101", "5901", "6101"]);
    expect(body.vatCodes.map((v: any) => v.code).sort()).toEqual(["IMP77", "IMP81", "NOVAT", "imp81"]);
  });

  it("WellD Italia's entries are never read, offered, copied or chosen: a number both entities use is WellD CH's", async () => {
    const r = await createRequest([{ type: "stationery" }]);
    const offered = JSON.stringify((await options()).body);
    expect(offered).not.toContain("Ufficio IT");
    expect(offered).not.toContain("7777");
    const only = await classify(r.id, r.lineIds[0]!, { accountNumber: "7777" });
    expect(only.status).toBe(422);
    expect(only.body.code).toBe("ledger_account_not_found");
    expect((await classify(r.id, r.lineIds[0]!, { accountNumber: "6101" })).status).toBe(200);
    expect(await lineOf(r.lineIds[0]!)).toMatchObject({ accountNumber: "6101", accountName: "Ufficio" }); // not "Ufficio IT"
    expect(JSON.stringify(await Promise.all([getDefaults(), view(r.id)]))).not.toContain("Ufficio IT");
    expect([...directory.entitiesAsked]).toEqual(["welld_ch"]); // Refund asked for WellD CH, and only for it
  });
});

describe("the release seeds by natural key, whatever Accounting's ids are", () => {
  it("a dry run before and after a re-entry gives the same report; the real run writes number and name, code and rate, no id", async () => {
    await truncateRefundTables({ released: false });
    const defaults = {
      typeDefaults: {
        travel_train: { ledgerAccount: "5901", vatCode: "IMP81" },
        office_material: { ledgerAccount: "6101", vatCode: "NOVAT" },
      },
      foreignCurrencyVatCode: "NOVAT",
    } as never;
    const run = (dryRun: boolean) => runAccountingRelease({ accounting: port, defaults, dryRun, now: () => new Date("2026-11-20T08:00:00.000Z") });

    const before = await run(true);
    directory.renumber();
    directory.shuffleReads = true;
    const after = await run(true);
    expect(after).toEqual(before);
    expect(after.seeded.typeDefaults).toEqual(["travel_train", "office_material"]);
    expect(after.seeded.foreignCurrencyVatCode).toBe("NOVAT");

    const real = await run(false);
    expect(real.seeded).toEqual(after.seeded);
    const rows = (await db.expenseTypeAccountingDefault.findMany()).sort((a, b) => (a.type < b.type ? -1 : 1));
    expect(rows.map((r) => [r.type, r.accountNumber, r.accountName, r.vatCode, r.vatLabel, r.vatRateBasisPoints])).toEqual([
      ["office_material", "6101", "Ufficio", "NOVAT", "Senza IVA", 0],
      ["travel_train", "5901", "Treno", "IMP81", "IVA 8.1%", 810],
    ]);
    expect(await refundRowsAsText()).not.toContain(ID_PREFIX);
  });
});

describe("no id of Accounting is in Refund (D1)", () => {
  it("not in a stored row, not in an answer, whatever the operation, before and after a re-entry", async () => {
    await saveDefault("travel_train", "5901", "IMP81");
    await saveDefault("office_material", "6101", "NOVAT");
    await designate("NOVAT");
    const r = await createRequest([{ type: "travel_train" }, { type: "office_material", currency: "EUR", date: "2026-03-03" }, { type: "stationery" }]);
    await classify(r.id, r.lineIds[2]!, { accountNumber: "6101", vatCode: "IMP77" });
    await view(r.id);
    await options();
    directory.renumber();
    await approve(r.id);
    const batchId = await batchWith(r.id);
    await call(exportRouter, "GET", `/batches/${batchId}/accounting-export`);
    await call(exportRouter, "GET", `/batches/${batchId}/accounting-export/csv`);
    await getDefaults();
    await view(r.id);

    expect(answers.length).toBeGreaterThan(8);
    for (const text of answers) expect(text).not.toContain(ID_PREFIX);
    expect(await refundRowsAsText()).not.toContain(ID_PREFIX);

    // The old foreign keys are never written, and the new tables have no column that could hold an id of Accounting.
    for (const id of r.lineIds) {
      const line = await lineOf(id);
      expect([line.ledgerAccountId, line.vatCodeId]).toEqual([null, null]);
    }
    const row = (await db.expenseTypeAccountingDefault.findFirstOrThrow()) as Record<string, unknown>;
    expect(Object.keys(row).filter((key) => /accountingId|ledgerAccountId|vatCodeId|externalId/i.test(key))).toEqual([]);
  });

  it("an Accounting that would send an internal id is refused as unreadable, never trusted (the wire is strict)", async () => {
    directory.sendIds = true;
    const out = await options();
    expect(out.status).toBe(503);
    expect(out.body.code).toBe("accounting_unavailable");
    expect(JSON.stringify(out.body)).not.toContain(ID_PREFIX);
    const r = await createRequest([{ type: "stationery" }]);
    expect((await classify(r.id, r.lineIds[0]!, { accountNumber: "6101" })).status).toBe(503);
    expect((await approve(r.id)).status).toBe(503);
  });
});
