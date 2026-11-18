/**
 * The accounting view and the classification options (T13, specs/20261118-
 * refund-accounting-export; T14 extends this file with the PUT).
 *
 * Real Postgres, jwt/authz mocked (`test-support/testAuth.ts`). Plan rows:
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
