/**
 * The accounting view and the classification options (T13, specs/20261118-
 * refund-accounting-export; T14 extends this file with the PUT).
 *
 * Real Postgres, jwt/authz mocked (`test-support/testAuth.ts`). T14 adds the PUT: AC-3.3, AC-3.6, AC-3.7, AC-3.9,
 * AC-1.3/1.6/1.9/1.10, and the status decided on the locked request row (R7). Plan rows:
 *   AC-3.1  CHF line: type defaults, marked as defaults
 *   AC-3.2  foreign-currency line: the type's account + the foreign-currency VAT code
 *   AC-3.8  CHF and VAT amounts derived on read; no rate is `rateMissing`, never 0
 *   AC-3.9  WellD Italia line: no classification
 *   AC-3.10 an owner without `request:review` reads nothing here (404)
 *   AC-1.3 / AC-1.6  deactivated entries are not offered; a stored value stays, `active: false`
 *   AC-2.7  an inactive designation is no VAT code
 *   AC-4.6  the employee's name travels with the line
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { ResolveResponse } from "../authz/resolveClient";
import { truncateRefundTables } from "../test-support/dbCleanup";
import { setupTestAuth } from "../test-support/testAuth";

process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = "http://localhost:3001/auth/jwks";
process.env["AUTH_ISSUER"] = "http://localhost:3001";
process.env["AUTH_BASE_URL"] = "http://localhost:3001";
process.env["AUTH_AUDIENCE"] = "operai-suite";
process.env["NODE_ENV"] = "test";

const harness = setupTestAuth();
await harness.init();

const { classificationRouter } = await import("./classification.routes");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");

const reviewer = (entity: string | null, conditioned = true): ResolveResponse => ({
  sub: "",
  epoch: 1,
  permissions: [
    { resource: "refund", action: "access", conditions: null },
    { resource: "request", action: "review", conditions: conditioned ? { attributes: [{ key: "entity", match: "user" }] } : null },
  ],
  entity,
  jobTitle: null,
});
const GLOBAL_REVIEWER = reviewer(null, false);
const OWNER_ONLY: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [
    { resource: "refund", action: "access", conditions: null },
    { resource: "request", action: "create", conditions: null },
    { resource: "request", action: "read", conditions: { attributes: [{ key: "ownership", match: "own" }] } },
  ],
  entity: null,
  jobTitle: null,
};
const NO_GRANTS: ResolveResponse = { sub: "", epoch: 1, permissions: [], entity: null, jobTitle: null };

const by = { createdByUserId: "admin", createdByEmail: "admin@welld.ch" };
const FOREIGN_KEY = "accounting.welld_ch.foreign-currency-vat-code";

let seq = 0; // distinct receipt sequence numbers across the requests of a test
let accountTrain: { id: string };
let accountOffice: { id: string };
let imp81: { id: string };
let novat: { id: string };

beforeEach(async () => {
  await truncateRefundTables();
  __resetAuthzCacheForTests();
  harness.setResolve(async () => GLOBAL_REVIEWER);
  accountTrain = await db.ledgerAccount.create({ data: { entity: "welld_ch", number: "5901", name: "Treno", ...by } });
  accountOffice = await db.ledgerAccount.create({ data: { entity: "welld_ch", number: "6101", name: "Ufficio", ...by } });
  imp81 = await db.vatCode.create({ data: { entity: "welld_ch", code: "IMP81", label: "IVA 8.1%", rateBasisPoints: 810, ...by } });
  novat = await db.vatCode.create({ data: { entity: "welld_ch", code: "NOVAT", label: "Senza IVA", rateBasisPoints: 0, ...by } });
  await db.expenseTypeDefault.create({ data: { entity: "welld_ch", type: "travel_train", ledgerAccountId: accountTrain.id, vatCodeId: imp81.id, ...by } });
  await db.expenseTypeDefault.create({ data: { entity: "welld_ch", type: "office_material", ledgerAccountId: accountOffice.id, vatCodeId: imp81.id, ...by } });
  await db.refundSetting.create({ data: { key: FOREIGN_KEY, value: novat.id, ...by } });
});
afterAll(async () => {
  await truncateRefundTables();
});

interface LineSpec {
  date?: string;
  type?: "travel_train" | "office_material" | "stationery";
  entity?: "welld_ch" | "welld_it";
  currency?: "CHF" | "EUR" | "USD" | "GBP";
  requestedAmountCents?: number;
  approvedTotalCents?: number | null;
  rejected?: boolean;
  receiptNumber?: string;
  stored?: { ledgerAccountId?: string; ledgerAccountIsDefault?: boolean; vatCodeId?: string; vatCodeIsDefault?: boolean };
}

async function createRequest(
  lines: LineSpec[],
  opts: { status?: "draft" | "submitted" | "approved" | "rejected" | "paid"; owner?: string; name?: string | null; batchId?: string } = {},
) {
  const request = await db.refundRequest.create({
    data: {
      ownerUserId: opts.owner ?? "emp-1",
      ownerEmail: `${opts.owner ?? "emp-1"}@welld.ch`,
      ownerName: opts.name === undefined ? "Matteo Codogno" : opts.name,
      status: opts.status ?? "submitted",
      ...(opts.batchId ? { batchId: opts.batchId } : {}),
    },
  });
  const ids: string[] = [];
  for (const spec of lines) {
    const n = ++seq;
    const line = await db.refundLine.create({
      data: {
        requestId: request.id,
        date: new Date(spec.date ?? "2026-03-02"),
        type: spec.type ?? "travel_train",
        motivo: "m",
        entity: spec.entity ?? "welld_ch",
        currency: spec.currency ?? "CHF",
        requestedAmountCents: spec.requestedAmountCents ?? 2080,
        approvedTotalCents: spec.approvedTotalCents === undefined ? null : spec.approvedTotalCents,
        createdAt: new Date(Date.UTC(2026, 2, 5, 10, 0, n)),
        ...(spec.rejected ? { rejectionReason: "no", rejectedAt: new Date(), rejectedByUserId: "a", rejectedByEmail: "a@x", approvedTotalCents: 0 } : {}),
        ...(spec.receiptNumber
          ? { receiptNumber: spec.receiptNumber, receiptOwnerUserId: request.ownerUserId, receiptYear: 2026, receiptSeq: n, numberedAt: new Date() }
          : {}),
        ...(spec.stored ?? {}),
      },
    });
    ids.push(line.id);
  }
  return { id: request.id, lineIds: ids };
}

async function createBatch(status: "compiled" | "paid") {
  return db.refundBatch.create({
    data: { cutoff: new Date("2026-03-31"), status, createdByUserId: "a", createdByEmail: "a@x", pdfObjectKey: `refund/batches/${crypto.randomUUID()}/compiled.pdf` },
  });
}

async function get(path: string, sub = "acct-1") {
  const token = await harness.signToken({ sub, email: `${sub}@welld.ch` });
  const res = await classificationRouter.request(path, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const view = (id: string, sub?: string) => get(`/review/requests/${id}/accounting`, sub);

const addRate = (currency: "EUR" | "USD" | "GBP", month: string, rateMicros: number, origin: "fetched" | "corrected" = "fetched", at?: string) =>
  db.exchangeRateEntry.create({
    data: {
      currency,
      month: new Date(`${month}-01T00:00:00.000Z`),
      rateMicros,
      origin,
      createdByUserId: origin === "fetched" ? "system:fx-fetch" : "admin",
      createdByEmail: "x@welld.ch",
      ...(origin === "fetched" ? { sourceUrl: "https://example.test", sourceMonth: month, fetchedAt: new Date() } : {}),
      ...(at ? { createdAt: new Date(at) } : {}),
    },
  });

describe("GET /review/requests/{id}/accounting: what a line shows", () => {
  it("(AC-3.1, AC-3.8) a CHF line shows its type's defaults marked as defaults, its CHF amount and its VAT", async () => {
    const r = await createRequest([{ type: "travel_train", requestedAmountCents: 2080 }]);
    const res = await view(r.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ requestId: r.id, status: "submitted", batch: null, classificationState: "review" });
    expect(res.body["lines"]).toHaveLength(1);
    expect(res.body["lines"][0]).toEqual({
      lineId: r.lineIds[0]!,
      entity: "welld_ch",
      date: "2026-03-02",
      type: "travel_train",
      currency: "CHF",
      amountCents: 2080,
      receiptNumber: null,
      employee: { name: "Matteo Codogno", email: "emp-1@welld.ch" },
      rejected: false,
      classification: {
        account: { id: accountTrain.id, number: "5901", name: "Treno", active: true },
        accountIsDefault: true,
        vatCode: { id: imp81.id, code: "IMP81", label: "IVA 8.1%", ratePercent: "8.1", active: true },
        vatCodeIsDefault: true,
      },
      chf: { amountCents: 2080, rateMicros: null, rate: null, rateMonth: null, rateMissing: false },
      vatAmountCents: 156, // AC-6.4 vector: 2080 at 8.1 % contains 156
    });
  });

  it("(AC-3.2) a line in EUR, USD or GBP shows the type's account and the foreign-currency VAT code, not the type's own", async () => {
    const r = await createRequest([
      { currency: "EUR", type: "travel_train" },
      { currency: "USD", type: "office_material" },
      { currency: "GBP", type: "travel_train" },
    ]);
    const lines = (await view(r.id)).body["lines"] as any[];
    for (const line of lines) {
      expect(line.classification.vatCode).toMatchObject({ code: "NOVAT", ratePercent: "0" });
      expect(line.classification.vatCodeIsDefault).toBe(true);
      expect(line.classification.accountIsDefault).toBe(true);
    }
    expect(lines.map((l) => l.classification.account.number)).toEqual(["5901", "6101", "5901"]);
  });

  it("(AC-3.8) a foreign line converts at the rate in effect, and VAT is computed on the CHF amount", async () => {
    await db.refundSetting.create({ data: { key: FOREIGN_KEY, value: imp81.id, ...by, createdAt: new Date(Date.now() + 1) } });
    await addRate("EUR", "2026-03", 924_600);
    const r = await createRequest([{ currency: "EUR", requestedAmountCents: 1040, date: "2026-03-15" }]);
    const line = (await view(r.id)).body["lines"][0];
    expect(line.chf).toEqual({ amountCents: 962, rateMicros: 924_600, rate: "0.9246", rateMonth: "2026-03", rateMissing: false }); // AC-6.3 vector
    expect(line.vatAmountCents).toBe(72); // 962 at 8.1 % contains round(962*810/10810) = 72
  });

  it("(AC-3.8) a corrected rate is the one in effect", async () => {
    await addRate("EUR", "2026-03", 924_600, "fetched", "2026-04-06T09:00:00Z");
    await addRate("EUR", "2026-03", 950_000, "corrected", "2026-04-07T09:00:00Z");
    const r = await createRequest([{ currency: "EUR", requestedAmountCents: 1000 }]);
    const line = (await view(r.id)).body["lines"][0];
    expect(line.chf).toMatchObject({ rateMicros: 950_000, rate: "0.9500", amountCents: 950 });
  });

  it("(AC-3.8) no rate: rateMissing, no CHF amount and no VAT amount, never 0; other currencies are unaffected", async () => {
    await addRate("USD", "2026-03", 780_800);
    const r = await createRequest([{ currency: "EUR" }, { currency: "USD", requestedAmountCents: 1000 }]);
    const [eur, usd] = (await view(r.id)).body["lines"] as any[];
    expect(eur.chf).toEqual({ amountCents: null, rateMicros: null, rate: null, rateMonth: "2026-03", rateMissing: true });
    expect(eur.vatAmountCents).toBeNull();
    expect(eur.classification.vatCode.code).toBe("NOVAT"); // the classification itself is still shown
    expect(usd.chf.amountCents).toBe(781);
    expect(usd.chf.rateMissing).toBe(false);
  });

  it("the rate is that of the MONTH of the line's date", async () => {
    await addRate("EUR", "2026-02", 900_000);
    await addRate("EUR", "2026-03", 924_600);
    const r = await createRequest([{ currency: "EUR", requestedAmountCents: 1000, date: "2026-02-28" }, { currency: "EUR", requestedAmountCents: 1000, date: "2026-03-01" }]);
    const [feb, mar] = (await view(r.id)).body["lines"] as any[];
    expect([feb.chf.rateMonth, feb.chf.amountCents]).toEqual(["2026-02", 900]);
    expect([mar.chf.rateMonth, mar.chf.amountCents]).toEqual(["2026-03", 925]);
  });

  it("(D11) the amount is approvedTotalCents when set, else the requested amount, and a line approved at 0 shows 0 and 0, not null", async () => {
    const r = await createRequest([{ requestedAmountCents: 1000, approvedTotalCents: 700 }, { requestedAmountCents: 1000, approvedTotalCents: 0 }, { requestedAmountCents: 1000 }]);
    const lines = (await view(r.id)).body["lines"] as any[];
    expect(lines.map((l) => l.amountCents)).toEqual([700, 0, 1000]);
    expect(lines[1].chf.amountCents).toBe(0);
    expect(lines[1].vatAmountCents).toBe(0);
  });

  it("an override stored on the line is shown as not-default, and the other half still follows its default", async () => {
    const r = await createRequest([{ stored: { ledgerAccountId: accountOffice.id, ledgerAccountIsDefault: false } }]);
    const c = (await view(r.id)).body["lines"][0].classification;
    expect(c.account).toMatchObject({ number: "6101" });
    expect(c.accountIsDefault).toBe(false);
    expect(c.vatCode.code).toBe("IMP81");
    expect(c.vatCodeIsDefault).toBe(true);
  });

  it("a type with no default shows no account and no VAT code (the approve refusal's reason), not an error", async () => {
    const r = await createRequest([{ type: "stationery" }]);
    const c = (await view(r.id)).body["lines"][0].classification;
    expect(c.account).toBeNull();
    expect(c.vatCode).toBeNull();
    expect((await view(r.id)).body["lines"][0].vatAmountCents).toBeNull();
  });

  it("(AC-3.9) a WellD Italia line has no classification and no CHF figure", async () => {
    const r = await createRequest([{ entity: "welld_it", currency: "EUR" }]);
    const line = (await view(r.id)).body["lines"][0];
    expect(line.classification).toBeNull();
    expect(line.chf).toEqual({ amountCents: null, rateMicros: null, rate: null, rateMonth: null, rateMissing: false });
    expect(line.vatAmountCents).toBeNull();
  });

  it("a rejected line is returned with classification null", async () => {
    const r = await createRequest([{ rejected: true }, {}]);
    const [rejected, other] = (await view(r.id)).body["lines"] as any[];
    expect(rejected.rejected).toBe(true);
    expect(rejected.classification).toBeNull();
    expect(rejected.chf.rateMissing).toBe(false);
    expect(other.rejected).toBe(false);
    expect(other.classification).not.toBeNull();
  });

  it("(AC-4.6) the line carries the employee's name and e-mail, and its receipt number once numbered", async () => {
    const r = await createRequest([{ receiptNumber: "MC26/014" }], { status: "approved", name: null });
    const line = (await view(r.id)).body["lines"][0];
    expect(line.receiptNumber).toBe("MC26/014");
    expect(line.employee).toEqual({ name: null, email: "emp-1@welld.ch" });
  });
});

describe("the catalog and the view (AC-1.3, AC-1.6, AC-2.7)", () => {
  it("a stored value whose entry was deactivated stays, with active: false", async () => {
    const r = await createRequest([{ stored: { ledgerAccountId: accountOffice.id, ledgerAccountIsDefault: false, vatCodeId: novat.id, vatCodeIsDefault: false } }]);
    await db.accountingCatalogStatus.create({ data: { ledgerAccountId: accountOffice.id, active: false, ...by } });
    await db.accountingCatalogStatus.create({ data: { vatCodeId: novat.id, active: false, ...by } });
    const c = (await view(r.id)).body["lines"][0].classification;
    expect(c.account).toMatchObject({ id: accountOffice.id, active: false });
    expect(c.vatCode).toMatchObject({ id: novat.id, active: false });
    expect(c.accountIsDefault).toBe(false);
  });

  it("(G3) a type default that points at a deactivated entry is no default: the half is null", async () => {
    await db.accountingCatalogStatus.create({ data: { ledgerAccountId: accountTrain.id, active: false, ...by } });
    await db.accountingCatalogStatus.create({ data: { vatCodeId: imp81.id, active: false, ...by } });
    const r = await createRequest([{ type: "travel_train" }]);
    expect((await view(r.id)).body["lines"][0].classification).toMatchObject({ account: null, vatCode: null });
    // reactivation brings the default back (AC-1.9, AC-1.10)
    await db.accountingCatalogStatus.create({ data: { ledgerAccountId: accountTrain.id, active: true, ...by } });
    await db.accountingCatalogStatus.create({ data: { vatCodeId: imp81.id, active: true, ...by } });
    expect((await view(r.id)).body["lines"][0].classification).toMatchObject({ account: { number: "5901", active: true }, vatCode: { code: "IMP81" } });
  });

  it("(AC-2.7) an inactive designation: a foreign line shows the default account and vatCode null, a CHF line is unaffected", async () => {
    await db.accountingCatalogStatus.create({ data: { vatCodeId: novat.id, active: false, ...by } });
    const r = await createRequest([{ currency: "EUR" }, { currency: "CHF" }]);
    const [eur, chf] = (await view(r.id)).body["lines"] as any[];
    expect(eur.classification.account.number).toBe("5901");
    expect(eur.classification.vatCode).toBeNull();
    expect(eur.vatAmountCents).toBeNull();
    expect(chf.classification.vatCode.code).toBe("IMP81");
    // reactivated: the default comes back with no further step
    await db.accountingCatalogStatus.create({ data: { vatCodeId: novat.id, active: true, ...by } });
    expect((await view(r.id)).body["lines"][0].classification.vatCode.code).toBe("NOVAT");
  });

  it("a cleared designation is no VAT code for a foreign line", async () => {
    await db.refundSetting.create({ data: { key: FOREIGN_KEY, value: null, ...by, createdAt: new Date(Date.now() + 1) } });
    const r = await createRequest([{ currency: "GBP" }]);
    expect((await view(r.id)).body["lines"][0].classification.vatCode).toBeNull();
  });
});

describe("states and frozen lines", () => {
  it("submitted is review; draft and rejected are none and classify nothing", async () => {
    const draft = await createRequest([{}], { status: "draft" });
    const rejected = await createRequest([{}], { status: "rejected" });
    const draftView = (await view(draft.id)).body;
    expect(draftView["classificationState"]).toBe("none");
    expect(draftView["lines"][0].classification).toBeNull();
    expect((await view(rejected.id)).body["classificationState"]).toBe("none");
  });

  it("approved is post_approval, with or without a compiled batch; the batch is returned", async () => {
    const free = await createRequest([{ receiptNumber: "MC26/001" }], { status: "approved" });
    expect((await view(free.id)).body).toMatchObject({ classificationState: "post_approval", batch: null });
    const batch = await createBatch("compiled");
    const compiled = await createRequest([{ receiptNumber: "MC26/002" }], { status: "approved", batchId: batch.id });
    expect((await view(compiled.id)).body).toMatchObject({ classificationState: "post_approval", batch: { id: batch.id, status: "compiled" } });
  });

  it("paid is locked", async () => {
    const batch = await createBatch("paid");
    const r = await createRequest([{ receiptNumber: "MC26/001" }], { status: "paid", batchId: batch.id });
    expect((await view(r.id)).body).toMatchObject({ classificationState: "locked", batch: { status: "paid" } });
  });

  it("(AC-2.3, AC-3.5) an approved line shows what is STORED and a defaults change does not move it", async () => {
    const r = await createRequest(
      [{ receiptNumber: "MC26/001", stored: { ledgerAccountId: accountTrain.id, ledgerAccountIsDefault: true, vatCodeId: imp81.id, vatCodeIsDefault: true } }],
      { status: "approved" },
    );
    await db.expenseTypeDefault.create({ data: { entity: "welld_ch", type: "travel_train", ledgerAccountId: accountOffice.id, vatCodeId: novat.id, ...by, createdAt: new Date(Date.now() + 1) } });
    const c = (await view(r.id)).body["lines"][0].classification;
    expect(c.account.number).toBe("5901");
    expect(c.vatCode.code).toBe("IMP81");
    expect(c.accountIsDefault).toBe(true);
  });

  it("(AC-7.2) an approved line left without an account or a VAT code shows it missing, even though a default now exists", async () => {
    const r = await createRequest([{ receiptNumber: "MC26/001", type: "travel_train", stored: { vatCodeId: imp81.id, vatCodeIsDefault: true } }], { status: "approved" });
    const c = (await view(r.id)).body["lines"][0].classification;
    expect(c.account).toBeNull(); // 5901 is the live default of travel_train and is NOT applied to a booked line
    expect(c.vatCode.code).toBe("IMP81");
  });

  it("an approved WellD Italia line still has no classification", async () => {
    const r = await createRequest([{ entity: "welld_it", currency: "EUR", receiptNumber: "MC26/003" }], { status: "approved" });
    const line = (await view(r.id)).body["lines"][0];
    expect(line.classification).toBeNull();
    expect(line.receiptNumber).toBe("MC26/003");
  });
});

describe("(AC-3.10) who can read it", () => {
  it("the owner of the request, holding no request:review, gets 404", async () => {
    const r = await createRequest([{}], { owner: "emp-1" });
    harness.setResolve(async () => OWNER_ONLY);
    expect((await view(r.id, "emp-1")).status).toBe(404);
  });

  it("a caller with no grants at all gets the same 404", async () => {
    const r = await createRequest([{}]);
    harness.setResolve(async () => NO_GRANTS);
    const res = await view(r.id, "nobody");
    expect(res.status).toBe(404);
    expect(res.body["detail"]).not.toContain("permission"); // the answer is that of a stranger
  });

  it("a reviewer scoped to welld_it does not see a request with only welld_ch lines", async () => {
    const r = await createRequest([{ entity: "welld_ch" }]);
    harness.setResolve(async () => reviewer("welld_it"));
    expect((await view(r.id)).status).toBe(404);
  });

  it("a reviewer scoped to welld_it sees a request that has at least one welld_it line, WellD CH lines included (whole request)", async () => {
    const r = await createRequest([{ entity: "welld_ch" }, { entity: "welld_it", currency: "EUR" }]);
    harness.setResolve(async () => reviewer("welld_it"));
    const res = await view(r.id);
    expect(res.status).toBe(200);
    expect(res.body["lines"]).toHaveLength(2);
  });

  it("a reviewer scoped to welld_ch sees it; a conditioned grant with no resolved entity matches nothing (404)", async () => {
    const r = await createRequest([{}]);
    harness.setResolve(async () => reviewer("welld_ch"));
    expect((await view(r.id)).status).toBe(200);
    harness.setResolve(async () => reviewer(null, true));
    __resetAuthzCacheForTests();
    expect((await view(r.id)).status).toBe(404);
  });

  it("an unknown request id is 404", async () => {
    expect((await view("nope")).status).toBe(404);
  });

  it("no token is 401", async () => {
    const r = await createRequest([{}]);
    const res = await classificationRouter.request(`/review/requests/${r.id}/accounting`);
    expect(res.status).toBe(401);
  });
});

describe("GET /accounting/options", () => {
  it("(AC-1.3, AC-1.6) lists active entries only, accounts by number and VAT codes with their rate", async () => {
    await db.accountingCatalogStatus.create({ data: { ledgerAccountId: accountTrain.id, active: false, ...by } });
    await db.accountingCatalogStatus.create({ data: { vatCodeId: novat.id, active: false, ...by } });
    const res = await get("/accounting/options");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ledgerAccounts: [{ id: accountOffice.id, number: "6101", name: "Ufficio" }],
      vatCodes: [{ id: imp81.id, code: "IMP81", label: "IVA 8.1%", ratePercent: "8.1" }],
    });
    // reactivated: offered again with the same number and name (AC-1.9, AC-1.10)
    await db.accountingCatalogStatus.create({ data: { ledgerAccountId: accountTrain.id, active: true, ...by } });
    expect(((await get("/accounting/options")).body["ledgerAccounts"] as any[]).map((a) => a.number)).toEqual(["5901", "6101"]);
  });

  it("is open to any request:review scope (an Italian-scoped reviewer included) and 403 without the capability", async () => {
    harness.setResolve(async () => reviewer("welld_it"));
    expect((await get("/accounting/options")).status).toBe(200);
    harness.setResolve(async () => OWNER_ONLY);
    __resetAuthzCacheForTests();
    const res = await get("/accounting/options", "emp-1");
    expect(res.status).toBe(403);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PUT /review/requests/{id}/lines/{lineId}/classification (T14)
// ═════════════════════════════════════════════════════════════════════════════

type Action = "review" | "set-approved-total" | "reclassify";
const grants = (actions: Action[], entity: string | null = null): ResolveResponse => ({
  sub: "",
  epoch: 1,
  permissions: [
    { resource: "refund", action: "access", conditions: null },
    ...actions.map((action) => ({
      resource: "request",
      action,
      conditions: entity ? { attributes: [{ key: "entity", match: "user" }] } : null,
    })),
  ],
  entity,
  jobTitle: null,
});
const FULL = grants(["review", "set-approved-total", "reclassify"]);
const SET_ONLY = grants(["review", "set-approved-total"]);
const RECLASSIFY_ONLY = grants(["review", "reclassify"]);

async function put(requestId: string, lineId: string, body: unknown, perms: ResolveResponse = FULL, sub = "acct-1") {
  harness.setResolve(async () => perms);
  __resetAuthzCacheForTests();
  const token = await harness.signToken({ sub, email: `${sub}@welld.ch` });
  const res = await classificationRouter.request(`/review/requests/${requestId}/lines/${lineId}/classification`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, any> = {};
  try {
    parsed = JSON.parse(text) as Record<string, any>;
  } catch {
    parsed = { text }; // Hono answers a body that is not JSON with plain text
  }
  return { status: res.status, body: parsed };
}

const auditOf = (requestId: string, action = "line_classified") =>
  db.refundAuditEntry.findMany({ where: { requestId, action: action as never }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
const lineRow = (id: string) => db.refundLine.findUniqueOrThrow({ where: { id } });

describe("PUT classification while submitted (AC-3.3)", () => {
  it("stores the chosen account as not-default, answers with the line, and audits who changed what from which value to which", async () => {
    const r = await createRequest([{ type: "travel_train" }]);
    const res = await put(r.id, r.lineIds[0]!, { ledgerAccountId: accountOffice.id });
    expect(res.status).toBe(200);
    expect(res.body["lineId"]).toBe(r.lineIds[0]!);
    expect(res.body["classification"].account).toEqual({ id: accountOffice.id, number: "6101", name: "Ufficio", active: true });
    expect(res.body["classification"].accountIsDefault).toBe(false);
    // the other half still follows its default
    expect(res.body["classification"].vatCodeIsDefault).toBe(true);
    expect(res.body["vatAmountCents"]).toBe(156);

    const stored = await lineRow(r.lineIds[0]!);
    expect(stored).toMatchObject({ ledgerAccountId: accountOffice.id, ledgerAccountIsDefault: false, vatCodeId: null, vatCodeIsDefault: null });

    const audit = await auditOf(r.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: "acct-1", actorEmail: "acct-1@welld.ch", lineId: r.lineIds[0]! });
    expect(audit[0]!.detail).toEqual({
      cause: "review",
      account: { from: { id: accountTrain.id, number: "5901" }, to: { id: accountOffice.id, number: "6101" }, fromDefault: true, toDefault: false },
      vatCode: {
        from: { id: imp81.id, code: "IMP81", rateBasisPoints: 810 },
        to: { id: imp81.id, code: "IMP81", rateBasisPoints: 810 },
        fromDefault: true,
        toDefault: true,
      },
    });
  });

  it("changes both halves in one call, with one audit row", async () => {
    const r = await createRequest([{ type: "travel_train" }]);
    const res = await put(r.id, r.lineIds[0]!, { ledgerAccountId: accountOffice.id, vatCodeId: novat.id });
    expect(res.status).toBe(200);
    expect(res.body["classification"]).toMatchObject({ accountIsDefault: false, vatCodeIsDefault: false, vatCode: { code: "NOVAT" } });
    expect(res.body["vatAmountCents"]).toBe(0);
    expect(await auditOf(r.id)).toHaveLength(1);
  });

  it("a second change records the first one as its 'from', not a default", async () => {
    const r = await createRequest([{ type: "travel_train" }]);
    await put(r.id, r.lineIds[0]!, { ledgerAccountId: accountOffice.id });
    await put(r.id, r.lineIds[0]!, { ledgerAccountId: accountTrain.id });
    const audit = await auditOf(r.id);
    expect(audit).toHaveLength(2);
    expect((audit[1]!.detail as any).account).toEqual({
      from: { id: accountOffice.id, number: "6101" },
      to: { id: accountTrain.id, number: "5901" },
      fromDefault: false,
      toDefault: false,
    });
  });

  it("a value the line already stores is a no-op: 200, nothing written, no audit row", async () => {
    const r = await createRequest([{ stored: { ledgerAccountId: accountOffice.id, ledgerAccountIsDefault: false } }]);
    const before = await lineRow(r.lineIds[0]!);
    const res = await put(r.id, r.lineIds[0]!, { ledgerAccountId: accountOffice.id });
    expect(res.status).toBe(200);
    expect(await lineRow(r.lineIds[0]!)).toEqual(before);
    expect(await auditOf(r.id)).toHaveLength(0);
  });

  it("the money and the decision are never touched", async () => {
    const r = await createRequest([{ requestedAmountCents: 1000, approvedTotalCents: 700 }]);
    const before = await db.refundRequest.findUniqueOrThrow({ where: { id: r.id } });
    await put(r.id, r.lineIds[0]!, { ledgerAccountId: accountOffice.id });
    const after = await db.refundRequest.findUniqueOrThrow({ where: { id: r.id } });
    expect(after).toEqual(before); // status, decided*, updatedAt: the request row is not written at all
    const line = await lineRow(r.lineIds[0]!);
    expect([line.approvedTotalCents, line.requestedAmountCents]).toEqual([700, 1000]);
  });

  it("approving afterwards freezes the override as chosen (not-default), and audits the approval's own row after the review row", async () => {
    const { classifyAndNumber } = await import("./numbering.repo");
    const { loadDefaultsSnapshot } = await import("./defaults.repo");
    const r = await createRequest([{ type: "travel_train" }]);
    await put(r.id, r.lineIds[0]!, { ledgerAccountId: accountOffice.id });
    const result = await db.$transaction(async (tx) =>
      classifyAndNumber(tx, {
        owner: { userId: "emp-1", name: "Matteo Codogno", email: "emp-1@welld.ch" },
        requestIds: [r.id],
        cause: "approval",
        actor: { userId: "acct-1", email: "acct-1@welld.ch" },
        snapshot: await loadDefaultsSnapshot(tx),
      }),
    );
    expect(result.ok).toBe(true);
    expect(await lineRow(r.lineIds[0]!)).toMatchObject({ ledgerAccountId: accountOffice.id, ledgerAccountIsDefault: false, vatCodeId: imp81.id, vatCodeIsDefault: true });
    expect((await auditOf(r.id)).map((a) => (a.detail as any).cause)).toEqual(["review", "approval"]);
  });
});

describe("PUT classification: refusals (AC-3.9, AC-1.3, AC-1.6, AC-1.9, AC-1.10)", () => {
  it("(AC-3.9) a WellD Italia line: 422 line_not_welld_ch, nothing written", async () => {
    const r = await createRequest([{ entity: "welld_it", currency: "EUR" }]);
    const res = await put(r.id, r.lineIds[0]!, { ledgerAccountId: accountOffice.id });
    expect(res.status).toBe(422);
    expect(res.body["code"]).toBe("line_not_welld_ch");
    expect((await lineRow(r.lineIds[0]!)).ledgerAccountId).toBeNull();
    expect(await auditOf(r.id)).toHaveLength(0);
  });

  it("a rejected line: 409 line_rejected", async () => {
    const r = await createRequest([{ rejected: true }, {}]);
    const res = await put(r.id, r.lineIds[0]!, { vatCodeId: novat.id });
    expect(res.status).toBe(409);
    expect(res.body["code"]).toBe("line_rejected");
  });

  it("(AC-1.3, AC-1.9) an inactive account is refused, and accepted again once reactivated, with nothing changed in between", async () => {
    await db.accountingCatalogStatus.create({ data: { ledgerAccountId: accountOffice.id, active: false, ...by } });
    const r = await createRequest([{ type: "travel_train" }]);
    const refused = await put(r.id, r.lineIds[0]!, { ledgerAccountId: accountOffice.id });
    expect(refused.status).toBe(422);
    expect(refused.body["code"]).toBe("ledger_account_inactive");
    expect((await lineRow(r.lineIds[0]!)).ledgerAccountId).toBeNull();
    expect(await auditOf(r.id)).toHaveLength(0);

    await db.accountingCatalogStatus.create({ data: { ledgerAccountId: accountOffice.id, active: true, ...by } });
    const accepted = await put(r.id, r.lineIds[0]!, { ledgerAccountId: accountOffice.id });
    expect(accepted.status).toBe(200);
    expect(accepted.body["classification"].account).toMatchObject({ number: "6101", active: true });
  });

  it("(AC-1.6, AC-1.10) an inactive VAT code is refused, and accepted again once reactivated", async () => {
    await db.accountingCatalogStatus.create({ data: { vatCodeId: novat.id, active: false, ...by } });
    const r = await createRequest([{}]);
    const refused = await put(r.id, r.lineIds[0]!, { vatCodeId: novat.id });
    expect([refused.status, refused.body["code"]]).toEqual([422, "vat_code_inactive"]);
    await db.accountingCatalogStatus.create({ data: { vatCodeId: novat.id, active: true, ...by } });
    expect((await put(r.id, r.lineIds[0]!, { vatCodeId: novat.id })).status).toBe(200);
  });

  it("one bad half refuses the whole call: the good half is not written either", async () => {
    await db.accountingCatalogStatus.create({ data: { vatCodeId: novat.id, active: false, ...by } });
    const r = await createRequest([{}]);
    const res = await put(r.id, r.lineIds[0]!, { ledgerAccountId: accountOffice.id, vatCodeId: novat.id });
    expect(res.status).toBe(422);
    expect((await lineRow(r.lineIds[0]!)).ledgerAccountId).toBeNull();
  });

  it("an unknown id: 422 unknown_ledger_account / unknown_vat_code", async () => {
    const r = await createRequest([{}]);
    expect((await put(r.id, r.lineIds[0]!, { ledgerAccountId: "nope" })).body["code"]).toBe("unknown_ledger_account");
    expect((await put(r.id, r.lineIds[0]!, { vatCodeId: "nope" })).body["code"]).toBe("unknown_vat_code");
  });

  it("a line that keeps a deactivated value may be re-sent with it (not a new classification) while the other half changes", async () => {
    const r = await createRequest([{ stored: { ledgerAccountId: accountOffice.id, ledgerAccountIsDefault: false } }]);
    await db.accountingCatalogStatus.create({ data: { ledgerAccountId: accountOffice.id, active: false, ...by } });
    const res = await put(r.id, r.lineIds[0]!, { ledgerAccountId: accountOffice.id, vatCodeId: novat.id });
    expect(res.status).toBe(200);
    expect(res.body["classification"].account).toMatchObject({ number: "6101", active: false });
    expect(res.body["classification"].vatCode.code).toBe("NOVAT");
  });

  for (const [name, body] of [
    ["an empty body", {}],
    ["null for the account (there is no back-to-default)", { ledgerAccountId: null }],
    ["null for the VAT code", { vatCodeId: null }],
    ["a number", { ledgerAccountId: 12 }],
    ["an empty id", { vatCodeId: "" }],
    ["an unknown key", { ledgerAccountId: "x", note: "y" }],
  ] as const) {
    it(`422 for ${name}`, async () => {
      const r = await createRequest([{}]);
      const res = await put(r.id, r.lineIds[0]!, body);
      expect(res.status).toBe(422);
      expect(await auditOf(r.id)).toHaveLength(0);
    });
  }

  it("a body that is not JSON is refused (400), and one over 4 KiB is 413; nothing is written", async () => {
    const r = await createRequest([{}]);
    expect((await put(r.id, r.lineIds[0]!, "{not json")).status).toBe(400);
    expect((await put(r.id, r.lineIds[0]!, JSON.stringify({ ledgerAccountId: "x".repeat(5000) }))).status).toBe(413);
    expect(await auditOf(r.id)).toHaveLength(0);
  });
});

describe("PUT classification: who, and on which request (AC-3.6, R7)", () => {
  it("no request:set-approved-total and no request:reclassify: 403", async () => {
    const r = await createRequest([{}]);
    const res = await put(r.id, r.lineIds[0]!, { ledgerAccountId: accountOffice.id }, grants(["review"]));
    expect(res.status).toBe(403);
    const none = await put(r.id, r.lineIds[0]!, { ledgerAccountId: accountOffice.id }, NO_GRANTS);
    expect(none.status).toBe(403);
  });

  it("a submitted request needs set-approved-total: reclassify alone is 403", async () => {
    const r = await createRequest([{}]);
    const res = await put(r.id, r.lineIds[0]!, { ledgerAccountId: accountOffice.id }, RECLASSIFY_ONLY);
    expect(res.status).toBe(403);
    expect((await lineRow(r.lineIds[0]!)).ledgerAccountId).toBeNull();
  });

  it("(AC-3.6) an approved request needs request:reclassify: 200 with it, 403 without, and the approved total, status and decision stay", async () => {
    const decidedAt = new Date("2026-04-01T10:00:00Z");
    const r = await createRequest(
      [{ receiptNumber: "MC26/001", requestedAmountCents: 1000, approvedTotalCents: 800, stored: { ledgerAccountId: accountTrain.id, ledgerAccountIsDefault: true, vatCodeId: imp81.id, vatCodeIsDefault: true } }],
      { status: "approved" },
    );
    await db.refundRequest.update({ where: { id: r.id }, data: { decidedAt, decidedByUserId: "boss", decidedByEmail: "boss@welld.ch" } });
    const before = await db.refundRequest.findUniqueOrThrow({ where: { id: r.id } });

    const without = await put(r.id, r.lineIds[0]!, { ledgerAccountId: accountOffice.id }, SET_ONLY);
    expect(without.status).toBe(403); // set-approved-total is not what an approved line needs
    expect((await lineRow(r.lineIds[0]!)).ledgerAccountId).toBe(accountTrain.id);
    expect(await auditOf(r.id)).toHaveLength(0);

    const res = await put(r.id, r.lineIds[0]!, { ledgerAccountId: accountOffice.id, vatCodeId: novat.id }, RECLASSIFY_ONLY);
    expect(res.status).toBe(200);
    expect(res.body["classificationState"]).toBeUndefined(); // the answer is the line, not the view
    expect(res.body["classification"]).toMatchObject({ accountIsDefault: false, vatCodeIsDefault: false });
    expect(res.body["receiptNumber"]).toBe("MC26/001");

    expect(await db.refundRequest.findUniqueOrThrow({ where: { id: r.id } })).toEqual(before);
    const line = await lineRow(r.lineIds[0]!);
    expect([line.approvedTotalCents, line.requestedAmountCents, line.receiptNumber]).toEqual([800, 1000, "MC26/001"]);
    expect(line).toMatchObject({ ledgerAccountId: accountOffice.id, vatCodeId: novat.id });

    const audit = await auditOf(r.id);
    expect(audit).toHaveLength(1);
    expect((audit[0]!.detail as any).cause).toBe("post_approval");
    expect((audit[0]!.detail as any).account).toEqual({
      from: { id: accountTrain.id, number: "5901" },
      to: { id: accountOffice.id, number: "6101" },
      fromDefault: true,
      toDefault: false,
    });
  });

  it("(AC-3.6) an approved request in a COMPILED batch is still reclassifiable, and the batch is untouched", async () => {
    const batch = await createBatch("compiled");
    const r = await createRequest([{ receiptNumber: "MC26/001", stored: { ledgerAccountId: accountTrain.id, ledgerAccountIsDefault: true, vatCodeId: imp81.id, vatCodeIsDefault: true } }], {
      status: "approved",
      batchId: batch.id,
    });
    const res = await put(r.id, r.lineIds[0]!, { vatCodeId: novat.id }, RECLASSIFY_ONLY);
    expect(res.status).toBe(200);
    expect(await db.refundBatch.findUniqueOrThrow({ where: { id: batch.id } })).toEqual(batch);
    expect((await db.refundRequest.findUniqueOrThrow({ where: { id: r.id } })).batchId).toBe(batch.id);
  });

  it("an approved line writes only the named half: the other half is not resolved from the live defaults and written along", async () => {
    // left unclassified at release for want of a default (AC-7.2); a default exists NOW
    const r = await createRequest([{ receiptNumber: "MC26/001", type: "travel_train", stored: { vatCodeId: imp81.id, vatCodeIsDefault: true } }], { status: "approved" });
    const res = await put(r.id, r.lineIds[0]!, { vatCodeId: novat.id }, RECLASSIFY_ONLY);
    expect(res.status).toBe(200);
    expect(res.body["classification"].account).toBeNull(); // 5901 is travel_train's live default; it is not applied to a booked line
    expect(res.body["classification"].vatCode.code).toBe("NOVAT");
    expect((await lineRow(r.lineIds[0]!)).ledgerAccountId).toBeNull();
    // the audit says so too: the account half is "from null to null"
    expect(((await auditOf(r.id))[0]!.detail as any).account).toEqual({ from: null, to: null, fromDefault: false, toDefault: false });
    // and accounting can then set it
    const second = await put(r.id, r.lineIds[0]!, { ledgerAccountId: accountOffice.id }, RECLASSIFY_ONLY);
    expect(second.body["classification"].account.number).toBe("6101");
  });

  it("(AC-3.7) a paid request: 409 classification_locked, whoever asks, nothing written", async () => {
    const batch = await createBatch("paid");
    const r = await createRequest([{ receiptNumber: "MC26/001", stored: { ledgerAccountId: accountTrain.id, ledgerAccountIsDefault: true, vatCodeId: imp81.id, vatCodeIsDefault: true } }], {
      status: "paid",
      batchId: batch.id,
    });
    for (const perms of [FULL, RECLASSIFY_ONLY, SET_ONLY]) {
      const res = await put(r.id, r.lineIds[0]!, { vatCodeId: novat.id }, perms);
      expect([res.status, res.body["code"]]).toEqual([409, "classification_locked"]);
    }
    expect((await lineRow(r.lineIds[0]!)).vatCodeId).toBe(imp81.id);
    expect(await auditOf(r.id)).toHaveLength(0);
  });

  it("a draft or rejected request: 409 not_classifiable_status", async () => {
    for (const status of ["draft", "rejected"] as const) {
      const r = await createRequest([{}], { status });
      const res = await put(r.id, r.lineIds[0]!, { vatCodeId: novat.id });
      expect([res.status, res.body["code"]]).toEqual([409, "not_classifiable_status"]);
    }
  });

  it("404: out of the caller's entity scope, an unknown request, an unknown line, a line of ANOTHER request", async () => {
    const mine = await createRequest([{ entity: "welld_ch" }]);
    const other = await createRequest([{ entity: "welld_ch" }], { owner: "emp-2" });
    const italian = grants(["review", "set-approved-total", "reclassify"], "welld_it");
    expect((await put(mine.id, mine.lineIds[0]!, { vatCodeId: novat.id }, italian)).status).toBe(404);
    expect((await put("nope", mine.lineIds[0]!, { vatCodeId: novat.id })).status).toBe(404);
    expect((await put(mine.id, "nope", { vatCodeId: novat.id })).status).toBe(404);
    expect((await put(mine.id, other.lineIds[0]!, { vatCodeId: novat.id })).status).toBe(404);
    expect((await lineRow(other.lineIds[0]!)).vatCodeId).toBeNull();
  });

  it("a stranger learns nothing from the status: out of scope is 404 whatever the request's state and the caller's grants", async () => {
    const approved = await createRequest([{ entity: "welld_ch", receiptNumber: "MC26/001" }], { status: "approved" });
    const italianSetOnly = grants(["review", "set-approved-total"], "welld_it");
    // an approved request would be a 403 ("needs reclassify") for someone who can see it; for a stranger it is a 404
    expect((await put(approved.id, approved.lineIds[0]!, { vatCodeId: novat.id }, italianSetOnly)).status).toBe(404);
  });

  it("no token is 401", async () => {
    const r = await createRequest([{}]);
    const res = await classificationRouter.request(`/review/requests/${r.id}/lines/${r.lineIds[0]!}/classification`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vatCodeId: novat.id }),
    });
    expect(res.status).toBe(401);
  });

  it("(R7) the status is decided on the LOCKED request row: a PUT that waits for an approval is judged as approved", async () => {
    const r = await createRequest([{ type: "travel_train" }]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    // another transaction approves the request and holds the row lock a moment
    const approving = db.$transaction(async (tx) => {
      await tx.refundRequest.updateMany({ where: { id: r.id, status: "submitted" }, data: { status: "approved", decidedAt: new Date() } });
      await held;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const waiting = put(r.id, r.lineIds[0]!, { ledgerAccountId: accountOffice.id }, SET_ONLY);
    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    await approving;
    const res = await waiting;
    // set-approved-total was enough while it was submitted, and is not now: no override lands under the wrong grant
    expect(res.status).toBe(403);
    expect((await lineRow(r.lineIds[0]!)).ledgerAccountId).toBeNull();
  });
});
