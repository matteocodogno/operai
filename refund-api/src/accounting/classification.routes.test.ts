/**
 * The accounting view, the classification options and the classification PUT (T13 and T14 of specs/20261118-refund-
 * accounting-export, reworked by T19 of specs/20261119-accounting).
 *
 * Real Postgres, jwt/authz mocked (`test-support/testAuth.ts`), a FAKE `AccountingPort` (no network). Plan rows:
 *   AC-4.1  options: only the active WellD CH entries, with the exact key sets {number,name} and {code,label,ratePercent,
 *           rateBasisPoints}, for a reviewer with and without an Accounting grant
 *   AC-4.2  a welld_it-scoped reviewer: options 403 accounting_out_of_scope; the view's CH lines inScope false, no data
 *   AC-4.3  PUT with a deactivated number, an unknown number, a number only WellD Italia has: 422, the line and the audit
 *           count unchanged; the same for VAT codes
 *   AC-4.9  a WellD Italia line has no classification; a request with nothing to classify never calls Accounting
 *   AC-5.2  the copy (number and name, or code and rate) is written at the PUT, while submitted and while approved unpaid,
 *           with a `line_classified` v2 row from -> to
 *   AC-5.3  an approved line does not move when Accounting deactivates, renames or re-rates
 *   AC-5.6  an approved foreign-currency line with no rate is "pending": no CHF and no VAT amount, never 0
 *   AC-5.7  a post-approval PUT changes only the named half; the fx copy, the approved total, status and decision stay
 *   AC-6.5  Accounting unreachable (each kind): the view is 200 `accounting: "unavailable"` with what the lines hold,
 *           options 503, PUT 503 and the line unchanged
 *   AC-6.10 every refusal body carries no URL, host, id or stack text
 *   AC-7.3  `viewer.canOpenAccountingRates`
 *   AC-1.4 / AC-1.8 a deactivated entry is absent from the options and refused by the PUT
 * plus the 20261118 security rules, unchanged: line-level scope (SR-1), self-approval (SR-2), the status decided on the
 * locked row (R7).
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
process.env["ACCOUNTING_INTERNAL_URL"] = "http://localhost:8089";

const harness = setupTestAuth();
await harness.init();

const { classificationRouter } = await import("./classification.routes");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { ACCOUNTING_FAILURE_KINDS } = await import("./accountingClient");
const { createFakeAccounting, useFakeAccounting, restoreAccounting } = await import("../test-support/fakeAccounting");

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

/** The copies a line can hold, as the columns store them. */
const TRAIN = { accountNumber: "5901", accountName: "Treno" } as const;
const OFFICE = { accountNumber: "6101", accountName: "Ufficio" } as const;
const IMP81 = { vatCodeCopy: "IMP81", vatRateBasisPoints: 810 } as const;
const NOVAT = { vatCodeCopy: "NOVAT", vatRateBasisPoints: 0 } as const;

/** AC-6.10: a refusal names the cause and carries no address, identifier or internal text. */
const NO_INTERNALS = /https?:\/\/(?!httpstatuses\.com)|localhost|railway|\bc[a-z0-9]{24}\b|\bat .*\(/;
const expectClean = (body: unknown) => expect(JSON.stringify(body)).not.toMatch(NO_INTERNALS);

const fake = createFakeAccounting();
let seq = 0; // distinct receipt sequence numbers across the requests of a test

beforeEach(async () => {
  await truncateRefundTables();
  __resetAuthzCacheForTests();
  harness.setResolve(async () => GLOBAL_REVIEWER);
  fake.failWith(null).failReferenceDataWith(null).failRatesWith(null).setDelayMs(0).onRead(null).resetCalls();
  for (const a of ["5901", "6101", "9999"]) fake.removeAccount(a);
  for (const v of ["IMP81", "NOVAT", "IMP77"]) fake.removeVatCode(v);
  for (const m of ["2026-02", "2026-03", "2026-04"]) for (const c of ["EUR", "USD", "GBP"] as const) fake.removeRate(c, m);
  fake
    .setAccount("5901", "Treno")
    .setAccount("6101", "Ufficio")
    .setVatCode("IMP81", "IVA 8.1%", 810)
    .setVatCode("NOVAT", "Senza IVA", 0)
    .setVatCode("IMP77", "IVA 7.7%", 770);
  useFakeAccounting(fake);
  // Refund's recorded defaults (copies): train and office, and NOVAT for foreign currencies.
  await db.expenseTypeAccountingDefault.create({
    data: { entity: "welld_ch", type: "travel_train", accountNumber: "5901", accountName: "Treno", vatCode: "IMP81", vatLabel: "IVA 8.1%", vatRateBasisPoints: 810, ...by },
  });
  await db.expenseTypeAccountingDefault.create({
    data: { entity: "welld_ch", type: "office_material", accountNumber: "6101", accountName: "Ufficio", vatCode: "IMP81", vatLabel: "IVA 8.1%", vatRateBasisPoints: 810, ...by },
  });
  await db.foreignCurrencyVatDesignation.create({ data: { entity: "welld_ch", vatCode: "NOVAT", vatLabel: "Senza IVA", vatRateBasisPoints: 0, ...by } });
});
afterAll(async () => {
  restoreAccounting();
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
  /** The copy columns stored on the line. */
  stored?: Partial<{
    accountNumber: string;
    accountName: string;
    ledgerAccountIsDefault: boolean;
    vatCodeCopy: string;
    vatRateBasisPoints: number;
    vatCodeIsDefault: boolean;
    fxRateMicros: number;
    fxRateMonth: Date;
    fxRateCopiedAt: Date;
  }>;
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

/** A line of an approved request: booked copies of both halves, the way approval leaves them. */
const booked = (over: Partial<NonNullable<LineSpec["stored"]>> = {}): NonNullable<LineSpec["stored"]> => ({
  ...TRAIN,
  ledgerAccountIsDefault: true,
  ...IMP81,
  vatCodeIsDefault: true,
  ...over,
});

async function createBatch(status: "compiled" | "paid") {
  return db.refundBatch.create({
    data: { cutoff: new Date("2026-03-31"), status, createdByUserId: "a", createdByEmail: "a@x", pdfObjectKey: `refund/batches/${crypto.randomUUID()}/compiled.pdf` },
  });
}

async function get(path: string, sub = "acct-1") {
  const token = await harness.signToken({ sub, email: `${sub}@welld.ch` });
  const res = await classificationRouter.request(path, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json()) as Record<string, any>, headers: res.headers };
}
const view = (id: string, sub?: string) => get(`/review/requests/${id}/accounting`, sub);

describe("GET /review/requests/{id}/accounting: what a line shows", () => {
  it("(AC-4.5, AC-7.3) a CHF line shows its type's defaults marked as defaults, with Accounting's state, its CHF amount and its VAT", async () => {
    const r = await createRequest([{ type: "travel_train", requestedAmountCents: 2080 }]);
    const res = await view(r.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      requestId: r.id,
      status: "submitted",
      batch: null,
      classificationState: "review",
      accounting: "available",
      viewer: { canOpenAccountingRates: false },
    });
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
      inScope: true,
      classification: {
        account: { number: "5901", name: "Treno", state: "active" },
        accountIsDefault: true,
        vatCode: { code: "IMP81", label: "IVA 8.1%", ratePercent: "8.1", state: "active" },
        vatCodeIsDefault: true,
      },
      chf: { amountCents: 2080, rateMicros: null, rate: null, rateMonth: null, rateStatus: "not_applicable" },
      vatAmountCents: 156, // 2080 at 8.1 % contains 156
    });
  });

  it("(AC-3.2 of 20261118) a line in EUR, USD or GBP shows the type's account and the foreign-currency VAT code, not the type's own", async () => {
    const r = await createRequest([
      { currency: "EUR", type: "travel_train" },
      { currency: "USD", type: "office_material" },
      { currency: "GBP", type: "travel_train" },
    ]);
    const lines = (await view(r.id)).body["lines"] as any[];
    for (const line of lines) {
      expect(line.classification.vatCode).toMatchObject({ code: "NOVAT", ratePercent: "0", state: "active" });
      expect(line.classification.vatCodeIsDefault).toBe(true);
      expect(line.classification.accountIsDefault).toBe(true);
    }
    expect(lines.map((l) => l.classification.account.number)).toEqual(["5901", "6101", "5901"]);
  });

  it("a foreign line under review converts at the rate in effect now, and VAT is computed on the CHF amount", async () => {
    await db.foreignCurrencyVatDesignation.create({
      data: { entity: "welld_ch", vatCode: "IMP81", vatLabel: "IVA 8.1%", vatRateBasisPoints: 810, ...by, createdAt: new Date(Date.now() + 1000) },
    });
    fake.setRate("EUR", "2026-03", 924_600);
    const r = await createRequest([{ currency: "EUR", requestedAmountCents: 1040, date: "2026-03-15" }]);
    const line = (await view(r.id)).body["lines"][0];
    expect(line.chf).toEqual({ amountCents: 962, rateMicros: 924_600, rate: "0.9246", rateMonth: "2026-03", rateStatus: "in_effect" }); // AC-5.5 vector
    expect(line.vatAmountCents).toBe(72); // 962 at 8.1 % contains round(962*810/10810) = 72
  });

  it("a corrected rate is the one Accounting reports in effect", async () => {
    fake.setRate("EUR", "2026-03", 950_000, "corrected");
    const r = await createRequest([{ currency: "EUR", requestedAmountCents: 1000 }]);
    const line = (await view(r.id)).body["lines"][0];
    expect(line.chf).toMatchObject({ rateMicros: 950_000, rate: "0.9500", amountCents: 950, rateStatus: "in_effect" });
  });

  it("(AC-6.7 of 20261118 spirit) no rate: rateStatus missing, no CHF amount and no VAT amount, never 0; other currencies are unaffected", async () => {
    fake.setRate("USD", "2026-03", 780_800);
    const r = await createRequest([{ currency: "EUR" }, { currency: "USD", requestedAmountCents: 1000 }]);
    const [eur, usd] = (await view(r.id)).body["lines"] as any[];
    expect(eur.chf).toEqual({ amountCents: null, rateMicros: null, rate: null, rateMonth: "2026-03", rateStatus: "missing" });
    expect(eur.vatAmountCents).toBeNull();
    expect(eur.classification.vatCode.code).toBe("NOVAT"); // the classification itself is still shown
    expect(usd.chf.amountCents).toBe(781);
    expect(usd.chf.rateStatus).toBe("in_effect");
  });

  it("the rate is that of the MONTH of the line's date, and Accounting is asked once for the pairs of the request", async () => {
    fake.setRate("EUR", "2026-02", 900_000);
    fake.setRate("EUR", "2026-03", 924_600);
    const r = await createRequest([
      { currency: "EUR", requestedAmountCents: 1000, date: "2026-02-28" },
      { currency: "EUR", requestedAmountCents: 1000, date: "2026-03-01" },
      { currency: "EUR", requestedAmountCents: 1000, date: "2026-03-20" },
    ]);
    fake.resetCalls();
    const [feb, mar] = (await view(r.id)).body["lines"] as any[];
    expect([feb.chf.rateMonth, feb.chf.amountCents]).toEqual(["2026-02", 900]);
    expect([mar.chf.rateMonth, mar.chf.amountCents]).toEqual(["2026-03", 925]);
    expect(fake.reads).toEqual({ referenceData: 1, rates: 1, total: 2 });
    expect(fake.calls.find((c) => c.read === "rates")!.pairs).toEqual(["EUR:2026-02", "EUR:2026-03"]);
  });

  it("(D11) the amount is approvedTotalCents when set, else the requested amount, and a line approved at 0 shows 0 and 0, not null", async () => {
    const r = await createRequest([{ requestedAmountCents: 1000, approvedTotalCents: 700 }, { requestedAmountCents: 1000, approvedTotalCents: 0 }, { requestedAmountCents: 1000 }]);
    const lines = (await view(r.id)).body["lines"] as any[];
    expect(lines.map((l) => l.amountCents)).toEqual([700, 0, 1000]);
    expect(lines[1].chf.amountCents).toBe(0);
    expect(lines[1].vatAmountCents).toBe(0);
  });

  it("a copy stored on the line is shown as not-default, and the other half still follows its default", async () => {
    const r = await createRequest([{ stored: { ...OFFICE, ledgerAccountIsDefault: false } }]);
    const c = (await view(r.id)).body["lines"][0].classification;
    expect(c.account).toEqual({ number: "6101", name: "Ufficio", state: "active" });
    expect(c.accountIsDefault).toBe(false);
    expect(c.vatCode.code).toBe("IMP81");
    expect(c.vatCodeIsDefault).toBe(true);
  });

  it("a type with no default shows no account and no VAT code (the approve refusal's reason), not an error", async () => {
    const r = await createRequest([{ type: "stationery" }]);
    const line = (await view(r.id)).body["lines"][0];
    expect(line.classification).toMatchObject({ account: null, vatCode: null, accountIsDefault: false, vatCodeIsDefault: false });
    expect(line.vatAmountCents).toBeNull();
  });

  it("(AC-4.9) a WellD Italia line has no classification and no CHF figure", async () => {
    const r = await createRequest([{ entity: "welld_it", currency: "EUR" }]);
    const line = (await view(r.id)).body["lines"][0];
    expect(line.classification).toBeNull();
    expect(line.chf).toEqual({ amountCents: null, rateMicros: null, rate: null, rateMonth: null, rateStatus: "not_applicable" });
    expect(line.vatAmountCents).toBeNull();
  });

  it("a rejected line is returned with classification null", async () => {
    const r = await createRequest([{ rejected: true }, {}]);
    const [rejected, other] = (await view(r.id)).body["lines"] as any[];
    expect(rejected.rejected).toBe(true);
    expect(rejected.classification).toBeNull();
    expect(rejected.chf.rateStatus).toBe("not_applicable");
    expect(other.rejected).toBe(false);
    expect(other.classification).not.toBeNull();
  });

  it("(AC-4.6 of 20261118) the line carries the employee's name and e-mail, and its receipt number once numbered", async () => {
    const r = await createRequest([{ receiptNumber: "MC26/014", stored: booked() }], { status: "approved", name: null });
    const line = (await view(r.id)).body["lines"][0];
    expect(line.receiptNumber).toBe("MC26/014");
    expect(line.employee).toEqual({ name: null, email: "emp-1@welld.ch" });
  });
});

describe("what Accounting says of an entry: the state vocabulary (AC-4.5, SA-3, G8a, AC-1.4)", () => {
  it("a copy whose entry was deactivated stays as copied, with state deactivated", async () => {
    const r = await createRequest([{ stored: { ...OFFICE, ledgerAccountIsDefault: false, ...NOVAT, vatCodeIsDefault: false } }]);
    fake.setAccountActive("6101", false);
    fake.setVatCodeActive("NOVAT", false);
    const c = (await view(r.id)).body["lines"][0].classification;
    expect(c.account).toEqual({ number: "6101", name: "Ufficio", state: "deactivated" });
    expect(c.vatCode).toEqual({ code: "NOVAT", label: "Senza IVA", ratePercent: "0", state: "deactivated" });
    expect(c.accountIsDefault).toBe(false);
  });

  it("(G8a) a type default that points at a deactivated entry is reported WITH its state and isDefault true, never as null", async () => {
    fake.setAccountActive("5901", false);
    fake.setVatCodeActive("IMP81", false);
    const r = await createRequest([{ type: "travel_train" }]);
    const line = (await view(r.id)).body["lines"][0];
    expect(line.classification).toEqual({
      account: { number: "5901", name: "Treno", state: "deactivated" },
      accountIsDefault: true,
      vatCode: { code: "IMP81", label: "IVA 8.1%", ratePercent: "8.1", state: "deactivated" },
      vatCodeIsDefault: true,
    });
    expect(line.vatAmountCents).toBeNull(); // the rate that would be booked is unknown: unknown is never 0
    // reactivation brings the default back (AC-1.9, AC-1.10)
    fake.setAccountActive("5901", true);
    fake.setVatCodeActive("IMP81", true);
    expect((await view(r.id)).body["lines"][0]).toMatchObject({
      classification: { account: { state: "active" }, vatCode: { state: "active" } },
      vatAmountCents: 156,
    });
  });

  it("(SA-3) a default that Accounting no longer lists is not_found, shown as recorded", async () => {
    fake.removeAccount("5901");
    fake.removeVatCode("IMP81");
    const r = await createRequest([{ type: "travel_train" }]);
    expect((await view(r.id)).body["lines"][0].classification).toEqual({
      account: { number: "5901", name: "Treno", state: "not_found" },
      accountIsDefault: true,
      vatCode: { code: "IMP81", label: "IVA 8.1%", ratePercent: "8.1", state: "not_found" },
      vatCodeIsDefault: true,
    });
  });

  it("(AC-2.7 of 20261118) a deactivated designation: a foreign line shows the default account and the code deactivated, a CHF line is unaffected", async () => {
    fake.setVatCodeActive("NOVAT", false);
    const r = await createRequest([{ currency: "EUR" }, { currency: "CHF" }]);
    const [eur, chf] = (await view(r.id)).body["lines"] as any[];
    expect(eur.classification.account).toMatchObject({ number: "5901", state: "active" });
    expect(eur.classification.vatCode).toMatchObject({ code: "NOVAT", state: "deactivated" });
    expect(eur.vatAmountCents).toBeNull();
    expect(chf.classification.vatCode).toMatchObject({ code: "IMP81", state: "active" });
    fake.setVatCodeActive("NOVAT", true); // reactivated: the default comes back with no further step
    expect((await view(r.id)).body["lines"][0].classification.vatCode).toMatchObject({ code: "NOVAT", state: "active" });
  });

  it("a cleared designation is no VAT code for a foreign line", async () => {
    await db.foreignCurrencyVatDesignation.create({ data: { entity: "welld_ch", ...by, createdAt: new Date(Date.now() + 1000) } });
    const r = await createRequest([{ currency: "GBP" }]);
    expect((await view(r.id)).body["lines"][0].classification.vatCode).toBeNull();
  });
});

describe("states and booked lines", () => {
  it("submitted is review; draft and rejected are none and classify nothing", async () => {
    const draft = await createRequest([{}], { status: "draft" });
    const rejected = await createRequest([{}], { status: "rejected" });
    const draftView = (await view(draft.id)).body;
    expect(draftView["classificationState"]).toBe("none");
    expect(draftView["lines"][0].classification).toBeNull();
    expect((await view(rejected.id)).body["classificationState"]).toBe("none");
  });

  it("approved is post_approval, with or without a compiled batch; the batch is returned", async () => {
    const free = await createRequest([{ receiptNumber: "MC26/001", stored: booked() }], { status: "approved" });
    expect((await view(free.id)).body).toMatchObject({ classificationState: "post_approval", batch: null });
    const batch = await createBatch("compiled");
    const compiled = await createRequest([{ receiptNumber: "MC26/002", stored: booked() }], { status: "approved", batchId: batch.id });
    expect((await view(compiled.id)).body).toMatchObject({ classificationState: "post_approval", batch: { id: batch.id, status: "compiled" } });
  });

  it("paid is locked, and a locked view never calls Accounting", async () => {
    const batch = await createBatch("paid");
    const r = await createRequest([{ receiptNumber: "MC26/001", stored: booked() }], { status: "paid", batchId: batch.id });
    fake.resetCalls();
    const res = await view(r.id);
    expect(res.body).toMatchObject({ classificationState: "locked", batch: { status: "paid" }, accounting: "available" });
    expect(res.body["lines"][0].classification).toMatchObject({ account: { number: "5901", name: "Treno", state: "unverified" } });
    expect(fake.reads.total).toBe(0);
  });

  it("(AC-5.3) an approved line shows what is STORED: Accounting deactivating, renaming or re-rating changes nothing of the booking", async () => {
    const r = await createRequest(
      [
        {
          currency: "EUR",
          requestedAmountCents: 1040,
          receiptNumber: "MC26/001",
          stored: booked({ fxRateMicros: 924_600, fxRateMonth: new Date("2026-03-01T00:00:00Z"), fxRateCopiedAt: new Date() }),
        },
      ],
      { status: "approved" },
    );
    const before = (await view(r.id)).body["lines"][0];
    expect(before.chf).toEqual({ amountCents: 962, rateMicros: 924_600, rate: "0.9246", rateMonth: "2026-03", rateStatus: "copied" });
    expect(before.vatAmountCents).toBe(72);

    fake.setAccountActive("5901", false);
    fake.setVatCodeActive("IMP81", false);
    fake.setAccount("5901", "A completely new name");
    fake.setRate("EUR", "2026-03", 930_000, "corrected");
    await db.expenseTypeAccountingDefault.create({
      data: { entity: "welld_ch", type: "travel_train", accountNumber: "6101", accountName: "Ufficio", vatCode: "NOVAT", vatLabel: "x", vatRateBasisPoints: 0, ...by, createdAt: new Date(Date.now() + 1000) },
    });
    const after = (await view(r.id)).body["lines"][0];
    expect(after.chf).toEqual(before.chf);
    expect(after.vatAmountCents).toBe(72);
    expect(after.classification.account).toEqual({ number: "5901", name: "Treno", state: "active" }); // as booked; Accounting's name moved on
    expect(after.classification.vatCode).toMatchObject({ code: "IMP81", ratePercent: "8.1", state: "deactivated" });
    expect(after.classification.accountIsDefault).toBe(true);
  });

  it("(AC-5.6) an approved foreign-currency line with no copied rate is pending: no CHF and no VAT amount, never 0, and no rate is asked", async () => {
    fake.setRate("EUR", "2026-03", 930_000); // in effect NOW, but the line is booked: it is copied at the first export
    const r = await createRequest([{ currency: "EUR", requestedAmountCents: 1040, receiptNumber: "MC26/001", stored: booked() }], { status: "approved" });
    fake.resetCalls();
    const line = (await view(r.id)).body["lines"][0];
    expect(line.chf).toEqual({ amountCents: null, rateMicros: null, rate: null, rateMonth: "2026-03", rateStatus: "pending" });
    expect(line.vatAmountCents).toBeNull();
    expect(fake.reads.rates).toBe(0);
  });

  it("(AC-7.2 of 20261118) an approved line left without an account or a VAT code shows it missing, even though a default now exists", async () => {
    const r = await createRequest([{ receiptNumber: "MC26/001", type: "travel_train", stored: { ...IMP81, vatCodeIsDefault: true } }], { status: "approved" });
    const c = (await view(r.id)).body["lines"][0].classification;
    expect(c.account).toBeNull(); // 5901 is the live default of travel_train and is NOT applied to a booked line
    expect(c.vatCode.code).toBe("IMP81");
  });

  it("an approved WellD Italia line still has no classification, and a request with no CH line never calls Accounting (AC-4.9)", async () => {
    const r = await createRequest([{ entity: "welld_it", currency: "EUR", receiptNumber: "MC26/003" }], { status: "approved" });
    fake.resetCalls();
    const line = (await view(r.id)).body["lines"][0];
    expect(line.classification).toBeNull();
    expect(line.receiptNumber).toBe("MC26/003");
    const submittedIt = await createRequest([{ entity: "welld_it", currency: "EUR" }, { rejected: true }]);
    await view(submittedIt.id);
    expect(fake.reads.total).toBe(0);
  });
});

describe("(AC-6.5) Accounting unreachable: the view is still a view", () => {
  for (const kind of ACCOUNTING_FAILURE_KINDS) {
    it(`${kind}: 200, accounting "unavailable", lines show what they hold and the recorded defaults as unverified`, async () => {
      fake.failWith(kind);
      const r = await createRequest([
        { type: "office_material", stored: { ...OFFICE, ledgerAccountIsDefault: false } },
        { type: "travel_train", currency: "EUR", requestedAmountCents: 1040 },
      ]);
      const res = await view(r.id);
      expect(res.status).toBe(200);
      expect(res.body["accounting"]).toBe("unavailable");
      const [held, followed] = res.body["lines"] as any[];
      expect(held.classification.account).toEqual({ number: "6101", name: "Ufficio", state: "unverified" });
      expect(held.classification.accountIsDefault).toBe(false);
      expect(held.classification.vatCode).toEqual({ code: "IMP81", label: "IVA 8.1%", ratePercent: "8.1", state: "unverified" }); // the recorded default
      expect(followed.classification.account).toEqual({ number: "5901", name: "Treno", state: "unverified" });
      expect(followed.chf).toEqual({ amountCents: null, rateMicros: null, rate: null, rateMonth: "2026-03", rateStatus: "unavailable" });
      expect(followed.vatAmountCents).toBeNull();
      expect(JSON.stringify(res.body)).not.toMatch(/https?:\/\/|localhost|railway/); // a view carries its own ids, but nothing of the peer
    });
  }

  it("an approved unpaid line shows what it holds, unverified, and its copied rate", async () => {
    fake.failWith("timeout");
    const r = await createRequest(
      [{ currency: "EUR", requestedAmountCents: 1040, receiptNumber: "MC26/001", stored: booked({ fxRateMicros: 924_600, fxRateMonth: new Date("2026-03-01T00:00:00Z"), fxRateCopiedAt: new Date() }) }],
      { status: "approved" },
    );
    const res = await view(r.id);
    expect(res.body["accounting"]).toBe("unavailable");
    expect(res.body["lines"][0]).toMatchObject({ chf: { amountCents: 962, rateStatus: "copied" }, classification: { account: { state: "unverified" } } });
  });

  it("only the rates failing is also unavailable, with the states still known", async () => {
    fake.failRatesWith("http_status");
    const r = await createRequest([{ currency: "EUR" }]);
    const res = await view(r.id);
    expect(res.body["accounting"]).toBe("unavailable");
    expect(res.body["lines"][0]).toMatchObject({ classification: { account: { state: "active" } }, chf: { rateStatus: "unavailable" } });
  });
});

describe("(AC-7.3) viewer.canOpenAccountingRates, decided server-side", () => {
  const withAccounting = (action: "read" | "manage", conditions: unknown = null): ResolveResponse => ({
    ...GLOBAL_REVIEWER,
    permissions: [...GLOBAL_REVIEWER.permissions, { resource: "accounting", action, conditions: conditions as never }],
  });

  it("true for accounting:read or manage covering WellD CH, false for none and for WellD Italia only", async () => {
    const r = await createRequest([{}]);
    const flag = async (perms: ResolveResponse) => {
      harness.setResolve(async () => perms);
      __resetAuthzCacheForTests();
      return (await view(r.id)).body["viewer"];
    };
    expect(await flag(GLOBAL_REVIEWER)).toEqual({ canOpenAccountingRates: false });
    expect(await flag(withAccounting("read"))).toEqual({ canOpenAccountingRates: true });
    expect(await flag(withAccounting("manage"))).toEqual({ canOpenAccountingRates: true });
    expect(await flag({ ...withAccounting("read", { attributes: [{ key: "entity", match: "user" }] }), entity: "welld_it" })).toEqual({ canOpenAccountingRates: false });
    expect(await flag({ ...withAccounting("read", { attributes: [{ key: "entity", match: "user" }] }), entity: "welld_ch" })).toEqual({ canOpenAccountingRates: true });
  });
});

describe("(AC-3.10 of 20261118) who can read it", () => {
  it("the owner of the request, holding no request:review, gets 404", async () => {
    const r = await createRequest([{}], { owner: "emp-1" });
    harness.setResolve(async () => OWNER_ONLY);
    expect((await view(r.id, "emp-1")).status).toBe(404);
  });

  it("a caller with no grants at all gets the same 404, and Accounting is not asked", async () => {
    const r = await createRequest([{}]);
    harness.setResolve(async () => NO_GRANTS);
    fake.resetCalls();
    const res = await view(r.id, "nobody");
    expect(res.status).toBe(404);
    expect(res.body["detail"]).not.toContain("permission"); // the answer is that of a stranger
    expect(fake.reads.total).toBe(0);
  });

  it("a reviewer scoped to welld_it does not see a request with only welld_ch lines", async () => {
    const r = await createRequest([{ entity: "welld_ch" }]);
    harness.setResolve(async () => reviewer("welld_it"));
    expect((await view(r.id)).status).toBe(404);
  });

  it("(SR-1, AC-4.2) a reviewer scoped to welld_it sees a request that has a welld_it line, but the WellD CH line carries no accounting data, and Accounting is not asked", async () => {
    const r = await createRequest([{ entity: "welld_ch" }, { entity: "welld_it", currency: "EUR" }]);
    harness.setResolve(async () => reviewer("welld_it"));
    fake.resetCalls();
    const res = await view(r.id);
    expect(res.status).toBe(200);
    expect(res.body["lines"]).toHaveLength(2);
    const ch = (res.body["lines"] as any[]).find((l) => l.entity === "welld_ch");
    const it = (res.body["lines"] as any[]).find((l) => l.entity === "welld_it");
    expect(ch.inScope).toBe(false);
    expect(ch.classification).toBeNull();
    expect(it.inScope).toBe(true);
    expect(fake.reads.total).toBe(0);
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

describe("GET /accounting/options (AC-4.1, AC-4.2, AC-4.4, D16)", () => {
  const reviewerWith = (...extra: { resource: string; action: string; conditions: null }[]): ResolveResponse => ({
    ...GLOBAL_REVIEWER,
    permissions: [...GLOBAL_REVIEWER.permissions, ...extra],
  });
  const asCaller = async (perms: ResolveResponse, sub = "acct-1") => {
    harness.setResolve(async () => perms);
    __resetAuthzCacheForTests();
    return get("/accounting/options", sub);
  };

  it("(AC-4.1, AC-1.4, AC-1.8) lists the active entries only, with the exact key sets and nothing else of Accounting", async () => {
    fake.setAccountActive("5901", false);
    fake.setVatCodeActive("NOVAT", false);
    const res = await get("/accounting/options");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ledgerAccounts: [{ number: "6101", name: "Ufficio" }],
      vatCodes: [
        { code: "IMP77", label: "IVA 7.7%", ratePercent: "7.7", rateBasisPoints: 770 },
        { code: "IMP81", label: "IVA 8.1%", ratePercent: "8.1", rateBasisPoints: 810 },
      ],
    });
    for (const item of res.body["ledgerAccounts"]) expect(Object.keys(item).sort()).toEqual(["name", "number"]);
    for (const item of res.body["vatCodes"]) expect(Object.keys(item).sort()).toEqual(["code", "label", "rateBasisPoints", "ratePercent"]);
    // reactivated: offered again with the same number and name (AC-1.9, AC-1.10)
    fake.setAccountActive("5901", true);
    expect(((await get("/accounting/options")).body["ledgerAccounts"] as any[]).map((a) => a.number)).toEqual(["5901", "6101"]);
  });

  it("an entry that exists only for WellD Italia is never offered", async () => {
    fake.setItalianAccount("9999", "Solo Italia");
    expect(JSON.stringify((await get("/accounting/options")).body)).not.toContain("9999");
  });

  it("is the same with and without an Accounting grant (AC-3.9): the data is the active WellD CH entries", async () => {
    const without = await asCaller(GLOBAL_REVIEWER);
    const withGrant = await asCaller(reviewerWith({ resource: "accounting", action: "manage", conditions: null }));
    expect(withGrant.body).toEqual(without.body);
  });

  it("(AC-4.2, SR-1) needs a review scope that covers welld_ch: global and welld_ch answer 200, welld_it and a scope with no entity answer 403 accounting_out_of_scope, no capability is a plain 403", async () => {
    for (const perms of [GLOBAL_REVIEWER, reviewer("welld_ch")]) expect((await asCaller(perms)).status).toBe(200);
    fake.resetCalls();
    for (const perms of [reviewer("welld_it"), reviewer(null, true)]) {
      const out = await asCaller(perms);
      expect([out.status, out.body["code"]]).toEqual([403, "accounting_out_of_scope"]);
      expect(out.body["ledgerAccounts"]).toBeUndefined(); // no account, no VAT code leaks with the refusal
      expectClean(out.body);
    }
    const res = await asCaller(OWNER_ONLY, "emp-1");
    expect([res.status, res.body["code"]]).toEqual([403, undefined]);
    expect(fake.reads.total).toBe(0); // refused before Accounting is read
  });

  it("(D16, AC-4.4) a settings:manage holder is served, with no review grant and no Accounting grant, and also when their review scope is welld_it", async () => {
    const admin: ResolveResponse = { sub: "", epoch: 1, entity: null, jobTitle: null, permissions: [{ resource: "settings", action: "manage", conditions: null }] };
    expect((await asCaller(admin)).status).toBe(200);
    const italianReviewerAndAdmin = { ...reviewer("welld_it"), permissions: [...reviewer("welld_it").permissions, { resource: "settings", action: "manage", conditions: null }] } as ResolveResponse;
    expect((await asCaller(italianReviewerAndAdmin)).status).toBe(200);
    // settings:read alone is not a way to choose
    const readOnly: ResolveResponse = { sub: "", epoch: 1, entity: null, jobTitle: null, permissions: [{ resource: "settings", action: "read", conditions: null }] };
    expect((await asCaller(readOnly)).status).toBe(403);
  });

  it("(AC-6.5, AC-6.10) Accounting unreachable, each kind: 503 accounting_unavailable with Retry-After, no list, a clean body", async () => {
    for (const kind of ACCOUNTING_FAILURE_KINDS) {
      fake.failWith(kind);
      const res = await get("/accounting/options");
      expect([res.status, res.body["code"], res.headers.get("Retry-After")]).toEqual([503, "accounting_unavailable", "30"]);
      expect(res.body["ledgerAccounts"]).toBeUndefined();
      expectClean(res.body);
    }
  });

  it("(AC-4.8) nothing is cached: two calls with the fake changed between them, two reads", async () => {
    fake.resetCalls();
    expect(((await get("/accounting/options")).body["ledgerAccounts"] as any[]).map((a) => a.number)).toEqual(["5901", "6101"]);
    fake.setAccountActive("5901", false);
    expect(((await get("/accounting/options")).body["ledgerAccounts"] as any[]).map((a) => a.number)).toEqual(["6101"]);
    expect(fake.reads).toEqual({ referenceData: 2, rates: 0, total: 2 });
  });

  it("no token is 401", async () => {
    expect((await classificationRouter.request("/accounting/options")).status).toBe(401);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PUT /review/requests/{id}/lines/{lineId}/classification
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
  return { status: res.status, body: parsed, headers: res.headers };
}

const auditOf = (requestId: string, action = "line_classified") =>
  db.refundAuditEntry.findMany({ where: { requestId, action: action as never }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
const lineRow = (id: string) => db.refundLine.findUniqueOrThrow({ where: { id } });

describe("PUT classification while submitted (AC-5.2)", () => {
  it("copies the chosen account (number and name) as not-default, answers with the line, and audits who changed what from which value to which", async () => {
    const r = await createRequest([{ type: "travel_train" }]);
    const res = await put(r.id, r.lineIds[0]!, { accountNumber: "6101" });
    expect(res.status).toBe(200);
    expect(res.body["lineId"]).toBe(r.lineIds[0]!);
    expect(res.body["classification"].account).toEqual({ number: "6101", name: "Ufficio", state: "active" });
    expect(res.body["classification"].accountIsDefault).toBe(false);
    // the other half still follows its default
    expect(res.body["classification"].vatCodeIsDefault).toBe(true);
    expect(res.body["vatAmountCents"]).toBe(156);

    const stored = await lineRow(r.lineIds[0]!);
    expect(stored).toMatchObject({ accountNumber: "6101", accountName: "Ufficio", ledgerAccountIsDefault: false, vatCodeCopy: null, vatCodeIsDefault: null });
    expect([stored.ledgerAccountId, stored.vatCodeId]).toEqual([null, null]); // the old foreign keys are never written

    const audit = await auditOf(r.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: "acct-1", actorEmail: "acct-1@welld.ch", lineId: r.lineIds[0]! });
    expect(audit[0]!.detail).toEqual({
      v: 2,
      cause: "review",
      account: { from: { number: "5901", name: "Treno" }, to: { number: "6101", name: "Ufficio" }, fromDefault: true, toDefault: false },
      vatCode: {
        from: { code: "IMP81", rateBasisPoints: 810 },
        to: { code: "IMP81", rateBasisPoints: 810 },
        fromDefault: true,
        toDefault: true,
      },
    });
  });

  it("copies Accounting's name as it is NOW, not what the caller or the options once said", async () => {
    fake.setAccount("6101", "Ufficio e cancelleria");
    const r = await createRequest([{}]);
    await put(r.id, r.lineIds[0]!, { accountNumber: "6101" });
    expect(await lineRow(r.lineIds[0]!)).toMatchObject({ accountNumber: "6101", accountName: "Ufficio e cancelleria" });
  });

  it("changes both halves in one call, with one audit row, and copies the rate of the VAT code", async () => {
    const r = await createRequest([{ type: "travel_train" }]);
    const res = await put(r.id, r.lineIds[0]!, { accountNumber: "6101", vatCode: "NOVAT" });
    expect(res.status).toBe(200);
    expect(res.body["classification"]).toMatchObject({ accountIsDefault: false, vatCodeIsDefault: false, vatCode: { code: "NOVAT", ratePercent: "0" } });
    expect(res.body["vatAmountCents"]).toBe(0);
    expect(await lineRow(r.lineIds[0]!)).toMatchObject({ vatCodeCopy: "NOVAT", vatRateBasisPoints: 0, vatCodeIsDefault: false });
    expect(await auditOf(r.id)).toHaveLength(1);
  });

  it("a second change records the first one as its 'from', not a default", async () => {
    const r = await createRequest([{ type: "travel_train" }]);
    await put(r.id, r.lineIds[0]!, { accountNumber: "6101" });
    await put(r.id, r.lineIds[0]!, { accountNumber: "5901" });
    const audit = await auditOf(r.id);
    expect(audit).toHaveLength(2);
    expect((audit[1]!.detail as any).account).toEqual({
      from: { number: "6101", name: "Ufficio" },
      to: { number: "5901", name: "Treno" },
      fromDefault: false,
      toDefault: false,
    });
  });

  it("a value the line already stores is a no-op: 200, nothing written, no audit row, and Accounting is read once, for the answer only", async () => {
    const r = await createRequest([{ stored: { ...OFFICE, ledgerAccountIsDefault: false } }]);
    const before = await lineRow(r.lineIds[0]!);
    fake.resetCalls();
    const res = await put(r.id, r.lineIds[0]!, { accountNumber: "6101" });
    expect(res.status).toBe(200);
    expect(await lineRow(r.lineIds[0]!)).toEqual(before);
    expect(await auditOf(r.id)).toHaveLength(0);
    expect(fake.reads).toEqual({ referenceData: 1, rates: 0, total: 1 }); // nothing to validate: the one read is the answer's states
  });

  it("the money and the decision are never touched", async () => {
    const r = await createRequest([{ requestedAmountCents: 1000, approvedTotalCents: 700 }]);
    const before = await db.refundRequest.findUniqueOrThrow({ where: { id: r.id } });
    await put(r.id, r.lineIds[0]!, { accountNumber: "6101" });
    const after = await db.refundRequest.findUniqueOrThrow({ where: { id: r.id } });
    expect(after).toEqual(before); // status, decided*, updatedAt: the request row is not written at all
    const line = await lineRow(r.lineIds[0]!);
    expect([line.approvedTotalCents, line.requestedAmountCents]).toEqual([700, 1000]);
    expect([line.fxRateMicros, line.fxRateMonth, line.fxRateCopiedAt]).toEqual([null, null, null]);
  });

  it("a foreign-currency line: the answer carries the rate in effect, and the PUT never copies it", async () => {
    fake.setRate("EUR", "2026-03", 924_600);
    const r = await createRequest([{ currency: "EUR", requestedAmountCents: 1040 }]);
    const res = await put(r.id, r.lineIds[0]!, { accountNumber: "6101" });
    expect(res.body["chf"]).toMatchObject({ rateStatus: "in_effect", amountCents: 962 });
    expect((await lineRow(r.lineIds[0]!)).fxRateMicros).toBeNull();
  });

  it("(AC-4.8) one PUT reads the reference data once", async () => {
    const r = await createRequest([{}]);
    fake.resetCalls();
    await put(r.id, r.lineIds[0]!, { accountNumber: "6101", vatCode: "NOVAT" });
    expect(fake.reads).toEqual({ referenceData: 1, rates: 0, total: 1 });
  });
});

describe("PUT classification: refusals (AC-4.3, AC-1.4, AC-1.8, AC-6.5, AC-6.10)", () => {
  it("(AC-4.9) a WellD Italia line: 422 line_not_welld_ch, nothing written, nothing read", async () => {
    const r = await createRequest([{ entity: "welld_it", currency: "EUR" }]);
    fake.resetCalls();
    const res = await put(r.id, r.lineIds[0]!, { accountNumber: "6101" });
    expect(res.status).toBe(422);
    expect(res.body["code"]).toBe("line_not_welld_ch");
    expect((await lineRow(r.lineIds[0]!)).accountNumber).toBeNull();
    expect(await auditOf(r.id)).toHaveLength(0);
    expect(fake.reads.total).toBe(0);
  });

  it("a rejected line: 409 line_rejected", async () => {
    const r = await createRequest([{ rejected: true }, {}]);
    const res = await put(r.id, r.lineIds[0]!, { vatCode: "NOVAT" });
    expect(res.status).toBe(409);
    expect(res.body["code"]).toBe("line_rejected");
  });

  it("(AC-4.3, AC-1.4, AC-1.9) a deactivated account is refused, and accepted again once reactivated, with nothing changed in between", async () => {
    fake.setAccountActive("6101", false);
    const r = await createRequest([{ type: "travel_train" }]);
    const refused = await put(r.id, r.lineIds[0]!, { accountNumber: "6101" });
    expect(refused.status).toBe(422);
    expect(refused.body["code"]).toBe("ledger_account_inactive");
    expectClean(refused.body);
    expect((await lineRow(r.lineIds[0]!)).accountNumber).toBeNull();
    expect(await auditOf(r.id)).toHaveLength(0);

    fake.setAccountActive("6101", true);
    const accepted = await put(r.id, r.lineIds[0]!, { accountNumber: "6101" });
    expect(accepted.status).toBe(200);
    expect(accepted.body["classification"].account).toMatchObject({ number: "6101", state: "active" });
  });

  it("(AC-4.3, AC-1.8, AC-1.10) a deactivated VAT code is refused, and accepted again once reactivated", async () => {
    fake.setVatCodeActive("NOVAT", false);
    const r = await createRequest([{}]);
    const refused = await put(r.id, r.lineIds[0]!, { vatCode: "NOVAT" });
    expect([refused.status, refused.body["code"]]).toEqual([422, "vat_code_inactive"]);
    fake.setVatCodeActive("NOVAT", true);
    expect((await put(r.id, r.lineIds[0]!, { vatCode: "NOVAT" })).status).toBe(200);
  });

  it("one bad half refuses the whole call: the good half is not written either", async () => {
    fake.setVatCodeActive("NOVAT", false);
    const r = await createRequest([{}]);
    const res = await put(r.id, r.lineIds[0]!, { accountNumber: "6101", vatCode: "NOVAT" });
    expect(res.status).toBe(422);
    expect((await lineRow(r.lineIds[0]!)).accountNumber).toBeNull();
    expect(await auditOf(r.id)).toHaveLength(0);
  });

  it("(AC-4.3) an unknown number, a number only WellD Italia has, and a code that does not exist: 422 *_not_found, no echo", async () => {
    fake.setItalianAccount("9999", "Solo Italia");
    const r = await createRequest([{}]);
    for (const body of [{ accountNumber: "nope" }, { accountNumber: "9999" }]) {
      const res = await put(r.id, r.lineIds[0]!, body);
      expect([res.status, res.body["code"]]).toEqual([422, "ledger_account_not_found"]);
      expect(res.body["detail"]).not.toContain(body.accountNumber);
      expectClean(res.body);
    }
    const unknownVat = await put(r.id, r.lineIds[0]!, { vatCode: "nope" });
    expect([unknownVat.status, unknownVat.body["code"]]).toEqual([422, "vat_code_not_found"]);
    expect((await put(r.id, r.lineIds[0]!, { vatCode: "imp81" })).body["code"]).toBe("vat_code_not_found"); // the key is exact
    expect(await lineRow(r.lineIds[0]!)).toMatchObject({ accountNumber: null, vatCodeCopy: null });
    expect(await auditOf(r.id)).toHaveLength(0);
  });

  it("a line that keeps a deactivated value may be re-sent with it (not a new classification) while the other half changes", async () => {
    const r = await createRequest([{ stored: { ...OFFICE, ledgerAccountIsDefault: false } }]);
    fake.setAccountActive("6101", false);
    const res = await put(r.id, r.lineIds[0]!, { accountNumber: "6101", vatCode: "NOVAT" });
    expect(res.status).toBe(200);
    expect(res.body["classification"].account).toMatchObject({ number: "6101", state: "deactivated" });
    expect(res.body["classification"].vatCode.code).toBe("NOVAT");
  });

  for (const [name, body] of [
    ["an empty body", {}],
    ["null for the account (there is no back-to-default)", { accountNumber: null }],
    ["null for the VAT code", { vatCode: null }],
    ["a number", { accountNumber: 12 }],
    ["an empty key", { vatCode: "" }],
    ["an unknown key", { accountNumber: "6101", note: "y" }],
    ["the old id body", { ledgerAccountId: "x" }],
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
    expect((await put(r.id, r.lineIds[0]!, JSON.stringify({ accountNumber: "x".repeat(5000) }))).status).toBe(413);
    expect(await auditOf(r.id)).toHaveLength(0);
  });
});

describe("(AC-6.5, AC-6.2) PUT classification with Accounting unreachable", () => {
  for (const kind of ACCOUNTING_FAILURE_KINDS) {
    it(`${kind}: 503 accounting_unavailable with Retry-After, the line unchanged, no audit row`, async () => {
      const r = await createRequest([{ stored: { ...OFFICE, ledgerAccountIsDefault: false } }]);
      const before = await lineRow(r.lineIds[0]!);
      fake.failWith(kind);
      const res = await put(r.id, r.lineIds[0]!, { accountNumber: "5901", vatCode: "NOVAT" });
      expect([res.status, res.body["code"], res.headers.get("Retry-After")]).toEqual([503, "accounting_unavailable", "30"]);
      expectClean(res.body);
      expect(await lineRow(r.lineIds[0]!)).toEqual(before);
      expect(await auditOf(r.id)).toHaveLength(0);
    });
  }

  it("a later attempt, with Accounting back, succeeds", async () => {
    const r = await createRequest([{}]);
    fake.failWith("network");
    expect((await put(r.id, r.lineIds[0]!, { accountNumber: "6101" })).status).toBe(503);
    fake.failWith(null);
    expect((await put(r.id, r.lineIds[0]!, { accountNumber: "6101" })).status).toBe(200);
  });

  it("a refusal that needs no Accounting wins over the 503: a stranger, a paid request and a missing grant are answered as usual", async () => {
    fake.failWith("timeout");
    const mine = await createRequest([{ entity: "welld_ch" }]);
    expect((await put(mine.id, mine.lineIds[0]!, { accountNumber: "6101" }, grants(["review", "set-approved-total"], "welld_it"))).status).toBe(404);
    expect((await put(mine.id, mine.lineIds[0]!, { accountNumber: "6101" }, grants(["review"]))).status).toBe(403);
    const batch = await createBatch("paid");
    const paid = await createRequest([{ receiptNumber: "MC26/001", stored: booked() }], { status: "paid", batchId: batch.id });
    expect((await put(paid.id, paid.lineIds[0]!, { vatCode: "NOVAT" })).body["code"]).toBe("classification_locked");
    fake.resetCalls();
    await put(mine.id, mine.lineIds[0]!, { accountNumber: "6101" }, grants(["review"]));
    expect(fake.reads.total).toBe(0);
  });
});

describe("PUT classification: who, and on which request (AC-5.7, R7)", () => {
  it("no request:set-approved-total and no request:reclassify: 403", async () => {
    const r = await createRequest([{}]);
    const res = await put(r.id, r.lineIds[0]!, { accountNumber: "6101" }, grants(["review"]));
    expect(res.status).toBe(403);
    const none = await put(r.id, r.lineIds[0]!, { accountNumber: "6101" }, NO_GRANTS);
    expect(none.status).toBe(403);
  });

  it("a submitted request needs set-approved-total: reclassify alone is 403", async () => {
    const r = await createRequest([{}]);
    const res = await put(r.id, r.lineIds[0]!, { accountNumber: "6101" }, RECLASSIFY_ONLY);
    expect(res.status).toBe(403);
    expect((await lineRow(r.lineIds[0]!)).accountNumber).toBeNull();
  });

  it("(AC-5.2, AC-5.7) an approved request needs request:reclassify: 200 with it, 403 without; only the named copies change, the fx copy, the approved total, status and decision stay", async () => {
    const decidedAt = new Date("2026-04-01T10:00:00Z");
    const fxCopiedAt = new Date("2026-04-01T10:00:00Z");
    const r = await createRequest(
      [
        {
          currency: "EUR",
          receiptNumber: "MC26/001",
          requestedAmountCents: 1000,
          approvedTotalCents: 800,
          stored: booked({ fxRateMicros: 924_600, fxRateMonth: new Date("2026-03-01T00:00:00Z"), fxRateCopiedAt: fxCopiedAt }),
        },
      ],
      { status: "approved" },
    );
    await db.refundRequest.update({ where: { id: r.id }, data: { decidedAt, decidedByUserId: "boss", decidedByEmail: "boss@welld.ch" } });
    const before = await db.refundRequest.findUniqueOrThrow({ where: { id: r.id } });

    const without = await put(r.id, r.lineIds[0]!, { accountNumber: "6101" }, SET_ONLY);
    expect(without.status).toBe(403); // set-approved-total is not what an approved line needs
    expect((await lineRow(r.lineIds[0]!)).accountNumber).toBe("5901");
    expect(await auditOf(r.id)).toHaveLength(0);

    const res = await put(r.id, r.lineIds[0]!, { accountNumber: "6101", vatCode: "NOVAT" }, RECLASSIFY_ONLY);
    expect(res.status).toBe(200);
    expect(res.body["classificationState"]).toBeUndefined(); // the answer is the line, not the view
    expect(res.body["classification"]).toMatchObject({ accountIsDefault: false, vatCodeIsDefault: false });
    expect(res.body["receiptNumber"]).toBe("MC26/001");
    expect(res.body["chf"]).toMatchObject({ rateStatus: "copied", rateMicros: 924_600 }); // the rate stays the line's own

    expect(await db.refundRequest.findUniqueOrThrow({ where: { id: r.id } })).toEqual(before);
    const line = await lineRow(r.lineIds[0]!);
    expect([line.approvedTotalCents, line.requestedAmountCents, line.receiptNumber]).toEqual([800, 1000, "MC26/001"]);
    expect(line).toMatchObject({ accountNumber: "6101", accountName: "Ufficio", vatCodeCopy: "NOVAT", vatRateBasisPoints: 0, fxRateMicros: 924_600 });
    expect(line.fxRateCopiedAt).toEqual(fxCopiedAt);

    const audit = await auditOf(r.id);
    expect(audit).toHaveLength(1);
    expect((audit[0]!.detail as any).cause).toBe("post_approval");
    expect((audit[0]!.detail as any).v).toBe(2);
    expect((audit[0]!.detail as any).account).toEqual({
      from: { number: "5901", name: "Treno" },
      to: { number: "6101", name: "Ufficio" },
      fromDefault: true,
      toDefault: false,
    });
  });

  it("an approved request in a COMPILED batch is still reclassifiable, and the batch is untouched", async () => {
    const batch = await createBatch("compiled");
    const r = await createRequest([{ receiptNumber: "MC26/001", stored: booked() }], { status: "approved", batchId: batch.id });
    const res = await put(r.id, r.lineIds[0]!, { vatCode: "NOVAT" }, RECLASSIFY_ONLY);
    expect(res.status).toBe(200);
    expect(await db.refundBatch.findUniqueOrThrow({ where: { id: batch.id } })).toEqual(batch);
    expect((await db.refundRequest.findUniqueOrThrow({ where: { id: r.id } })).batchId).toBe(batch.id);
  });

  it("an approved line writes only the named half: the other half is not resolved from the live defaults and written along", async () => {
    // left unclassified at release for want of a default (AC-7.2 of 20261118); a default exists NOW
    const r = await createRequest([{ receiptNumber: "MC26/001", type: "travel_train", stored: { ...IMP81, vatCodeIsDefault: true } }], { status: "approved" });
    const res = await put(r.id, r.lineIds[0]!, { vatCode: "NOVAT" }, RECLASSIFY_ONLY);
    expect(res.status).toBe(200);
    expect(res.body["classification"].account).toBeNull(); // 5901 is travel_train's live default; it is not applied to a booked line
    expect(res.body["classification"].vatCode.code).toBe("NOVAT");
    expect((await lineRow(r.lineIds[0]!)).accountNumber).toBeNull();
    // the audit says so too: the account half is "from null to null"
    expect(((await auditOf(r.id))[0]!.detail as any).account).toEqual({ from: null, to: null, fromDefault: false, toDefault: false });
    // and accounting can then set it
    const second = await put(r.id, r.lineIds[0]!, { accountNumber: "6101" }, RECLASSIFY_ONLY);
    expect(second.body["classification"].account.number).toBe("6101");
  });

  it("(AC-5.7 of 20261118's AC-3.7) a paid request: 409 classification_locked, whoever asks, nothing written, Accounting not asked", async () => {
    const batch = await createBatch("paid");
    const r = await createRequest([{ receiptNumber: "MC26/001", stored: booked() }], { status: "paid", batchId: batch.id });
    fake.resetCalls();
    for (const perms of [FULL, RECLASSIFY_ONLY, SET_ONLY]) {
      const res = await put(r.id, r.lineIds[0]!, { vatCode: "NOVAT" }, perms);
      expect([res.status, res.body["code"]]).toEqual([409, "classification_locked"]);
    }
    expect((await lineRow(r.lineIds[0]!)).vatCodeCopy).toBe("IMP81");
    expect(await auditOf(r.id)).toHaveLength(0);
    expect(fake.reads.total).toBe(0);
  });

  it("a draft or rejected request: 409 not_classifiable_status", async () => {
    for (const status of ["draft", "rejected"] as const) {
      const r = await createRequest([{}], { status });
      const res = await put(r.id, r.lineIds[0]!, { vatCode: "NOVAT" });
      expect([res.status, res.body["code"]]).toEqual([409, "not_classifiable_status"]);
    }
  });

  it("404: out of the caller's entity scope, an unknown request, an unknown line, a line of ANOTHER request", async () => {
    const mine = await createRequest([{ entity: "welld_ch" }]);
    const other = await createRequest([{ entity: "welld_ch" }], { owner: "emp-2" });
    const italian = grants(["review", "set-approved-total", "reclassify"], "welld_it");
    expect((await put(mine.id, mine.lineIds[0]!, { vatCode: "NOVAT" }, italian)).status).toBe(404);
    expect((await put("nope", mine.lineIds[0]!, { vatCode: "NOVAT" })).status).toBe(404);
    expect((await put(mine.id, "nope", { vatCode: "NOVAT" })).status).toBe(404);
    expect((await put(mine.id, other.lineIds[0]!, { vatCode: "NOVAT" })).status).toBe(404);
    expect((await lineRow(other.lineIds[0]!)).vatCodeCopy).toBeNull();
  });

  it("a stranger learns nothing from the status: out of scope is 404 whatever the request's state and the caller's grants", async () => {
    const approved = await createRequest([{ entity: "welld_ch", receiptNumber: "MC26/001", stored: booked() }], { status: "approved" });
    const italianSetOnly = grants(["review", "set-approved-total"], "welld_it");
    // an approved request would be a 403 ("needs reclassify") for someone who can see it; for a stranger it is a 404
    expect((await put(approved.id, approved.lineIds[0]!, { vatCode: "NOVAT" }, italianSetOnly)).status).toBe(404);
  });

  it("no token is 401", async () => {
    const r = await createRequest([{}]);
    const res = await classificationRouter.request(`/review/requests/${r.id}/lines/${r.lineIds[0]!}/classification`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vatCode: "NOVAT" }),
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
    const waiting = put(r.id, r.lineIds[0]!, { accountNumber: "6101" }, SET_ONLY);
    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    await approving;
    const res = await waiting;
    // set-approved-total was enough while it was submitted, and is not now: no copy lands under the wrong grant
    expect(res.status).toBe(403);
    expect((await lineRow(r.lineIds[0]!)).accountNumber).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Fix round 1 (T41 of 20261118): the QE repros D-2, D-3 and plan § Security review sync SR-1, SR-2: unchanged rules
// ═════════════════════════════════════════════════════════════════════════════

/** A caller with one grant per action, each with its own entity scope (`null` = unconditioned) and optional `self-approval: deny`. */
function perActionGrants(
  spec: Partial<Record<"review" | "set-approved-total" | "approve" | "reclassify", { entity?: boolean; selfDeny?: boolean }>>,
  entity: string | null,
): ResolveResponse {
  return {
    sub: "",
    epoch: 1,
    entity,
    jobTitle: null,
    permissions: [
      { resource: "refund", action: "access", conditions: null },
      ...Object.entries(spec).map(([action, opts]) => {
        const attributes = [
          ...(opts?.entity ? [{ key: "entity", match: "user" }] : []),
          ...(opts?.selfDeny ? [{ key: "self-approval", match: "deny" }] : []),
        ];
        return { resource: "request", action, conditions: attributes.length > 0 ? { attributes } : null };
      }),
    ],
  };
}

describe("(SR-1, S-01, D-2) entity scope is line level: a welld_it-scoped caller has nothing to do with a WellD CH line", () => {
  const mixed = () => createRequest([{ entity: "welld_ch" }, { entity: "welld_it", currency: "EUR" }]);

  it("D-2a: PUT on the CH line of a mixed SUBMITTED request is 404 for a welld_it-scoped caller, and nothing is written or read", async () => {
    const r = await mixed();
    fake.resetCalls();
    const res = await put(r.id, r.lineIds[0]!, { accountNumber: "6101" }, grants(["review", "set-approved-total"], "welld_it"));
    expect(res.status).toBe(404);
    expect(await lineRow(r.lineIds[0]!)).toMatchObject({ accountNumber: null, vatCodeCopy: null });
    expect(await auditOf(r.id)).toHaveLength(0);
    expect(fake.reads.total).toBe(0);
  });

  it("the same on an APPROVED request, under request:reclassify", async () => {
    const r = await createRequest(
      [{ entity: "welld_ch", receiptNumber: "MC26/001", stored: booked() }, { entity: "welld_it", currency: "EUR" }],
      { status: "approved" },
    );
    const res = await put(r.id, r.lineIds[0]!, { accountNumber: "6101" }, grants(["review", "reclassify"], "welld_it"));
    expect(res.status).toBe(404);
    expect((await lineRow(r.lineIds[0]!)).accountNumber).toBe("5901");
    expect(await auditOf(r.id)).toHaveLength(0);
  });

  it("the scope used is that of the grant the STATUS needs: welld_ch on set-approved-total but welld_it on reclassify is 200 while submitted and 404 once approved", async () => {
    const perms = perActionGrants({ review: {}, "set-approved-total": { entity: true }, reclassify: { entity: true } }, "welld_ch");
    const submitted = await createRequest([{ entity: "welld_ch" }, { entity: "welld_it", currency: "EUR" }]);
    expect((await put(submitted.id, submitted.lineIds[0]!, { accountNumber: "6101" }, perms)).status).toBe(200);
    const onlyReclassifyGlobal = perActionGrants({ review: {}, "set-approved-total": { entity: true }, reclassify: {} }, "welld_it");
    const approved = await createRequest(
      [{ entity: "welld_ch", receiptNumber: "MC26/001", stored: booked() }, { entity: "welld_it", currency: "EUR" }],
      { status: "approved" },
    );
    // submitted-grant scope would be welld_it (404 for the CH line) but the status is approved: reclassify is global, so 200
    expect((await put(approved.id, approved.lineIds[0]!, { accountNumber: "6101" }, onlyReclassifyGlobal)).status).toBe(200);
    const submittedIt = await createRequest([{ entity: "welld_ch" }, { entity: "welld_it", currency: "EUR" }]);
    // the mirror: set-approved-total scoped to welld_it while reclassify is global does NOT open a submitted CH line
    expect((await put(submittedIt.id, submittedIt.lineIds[0]!, { accountNumber: "6101" }, onlyReclassifyGlobal)).status).toBe(404);
  });

  it("a welld_ch-scoped caller and a global caller change the CH line as before", async () => {
    for (const perms of [grants(["review", "set-approved-total"], "welld_ch"), grants(["review", "set-approved-total"])]) {
      const r = await mixed();
      expect((await put(r.id, r.lineIds[0]!, { accountNumber: "6101" }, perms)).status).toBe(200);
    }
  });

  it("a welld_ch-scoped caller on the welld_it line of a mixed request: 404 (the line is outside their scope), a global caller gets 422 line_not_welld_ch", async () => {
    const r = await mixed();
    expect((await put(r.id, r.lineIds[1]!, { accountNumber: "6101" }, grants(["review", "set-approved-total"], "welld_ch"))).status).toBe(404);
    const global = await put(r.id, r.lineIds[1]!, { accountNumber: "6101" }, grants(["review", "set-approved-total"]));
    expect([global.status, global.body["code"]]).toEqual([422, "line_not_welld_ch"]);
  });

  it("D-2b: the view of a welld_it-scoped caller marks the CH line inScope false and carries no account, VAT code or CHF figure", async () => {
    fake.setRate("EUR", "2026-03", 924_600);
    const r = await createRequest([
      { entity: "welld_ch", currency: "EUR", requestedAmountCents: 1040, receiptNumber: "MC26/009" },
      { entity: "welld_it", currency: "EUR" },
    ]);
    harness.setResolve(async () => reviewer("welld_it"));
    __resetAuthzCacheForTests();
    const [ch, it] = (await view(r.id)).body["lines"] as any[];
    expect(ch).toEqual({
      lineId: r.lineIds[0]!,
      entity: "welld_ch",
      date: "2026-03-02",
      type: "travel_train",
      currency: "EUR",
      amountCents: 1040, // what GET /requests/{id} already shows a reviewer
      receiptNumber: "MC26/009",
      employee: { name: "Matteo Codogno", email: "emp-1@welld.ch" },
      rejected: false,
      inScope: false,
      classification: null,
      chf: null,
      vatAmountCents: null,
    });
    expect(JSON.stringify(ch)).not.toContain("5901"); // no account or VAT code anywhere in the line
    expect(JSON.stringify(ch)).not.toContain("IMP81");
    expect(it).toMatchObject({ entity: "welld_it", inScope: true, classification: null });
  });

  it("the view of a welld_ch-scoped caller: the CH line is in scope and complete, the welld_it line is not", async () => {
    const r = await mixed();
    harness.setResolve(async () => reviewer("welld_ch"));
    __resetAuthzCacheForTests();
    const [ch, it] = (await view(r.id)).body["lines"] as any[];
    expect(ch.inScope).toBe(true);
    expect(ch.classification.account.number).toBe("5901");
    expect(it).toMatchObject({ inScope: false, classification: null, chf: null, vatAmountCents: null });
  });

  it("a global caller sees every line in scope", async () => {
    const r = await mixed();
    expect(((await view(r.id)).body["lines"] as any[]).map((l) => l.inScope)).toEqual([true, true]);
  });

  it("the answer of a PUT is the line with inScope true", async () => {
    const r = await mixed();
    const res = await put(r.id, r.lineIds[0]!, { accountNumber: "6101" }, grants(["review", "set-approved-total"], "welld_ch"));
    expect(res.body["inScope"]).toBe(true);
  });
});

describe("(SR-2, S-02, D-3) segregation of duties: who may not approve their own request may not shape its booking", () => {
  // The grants of the QE repro: `approve` carries `self-approval: deny`, `reclassify` does not.
  const restricted: ResolveResponse = {
    sub: "",
    epoch: 1,
    entity: null,
    jobTitle: null,
    permissions: [
      { resource: "refund", action: "access", conditions: null },
      { resource: "request", action: "review", conditions: null },
      { resource: "request", action: "approve", conditions: { attributes: [{ key: "self-approval", match: "deny" }] } },
      { resource: "request", action: "reclassify", conditions: null },
    ],
  };
  const approvedOwn = (owner = "acct-1") => createRequest([{ entity: "welld_ch", stored: booked() }], { owner, status: "approved" });

  it("D-3: an owner barred from approving cannot reclassify their own approved request (403 self_approval_forbidden), and nothing is written or read", async () => {
    const r = await approvedOwn();
    fake.resetCalls();
    const res = await put(r.id, r.lineIds[0]!, { accountNumber: "6101" }, restricted, "acct-1");
    expect([res.status, res.body["code"]]).toEqual([403, "self_approval_forbidden"]);
    expect((await lineRow(r.lineIds[0]!)).accountNumber).toBe("5901");
    expect(await auditOf(r.id)).toHaveLength(0);
    expect(fake.reads.total).toBe(0);
  });

  it("the same while the request is SUBMITTED: the approve grant decides, set-approved-total itself stays unconditioned", async () => {
    const perms = perActionGrants({ review: {}, "set-approved-total": {}, approve: { selfDeny: true } }, null);
    const r = await createRequest([{ entity: "welld_ch" }], { owner: "acct-1" });
    const res = await put(r.id, r.lineIds[0]!, { accountNumber: "6101" }, perms, "acct-1");
    expect([res.status, res.body["code"]]).toEqual([403, "self_approval_forbidden"]);
    expect((await lineRow(r.lineIds[0]!)).accountNumber).toBeNull();
    // the same caller changes a colleague's request
    const other = await createRequest([{ entity: "welld_ch" }], { owner: "emp-9" });
    expect((await put(other.id, other.lineIds[0]!, { accountNumber: "6101" }, perms, "acct-1")).status).toBe(200);
  });

  it("the reclassify grant's own self-approval restriction counts once approved (the seeded shape), also without any approve grant", async () => {
    const perms = perActionGrants({ review: {}, reclassify: { selfDeny: true } }, null);
    const r = await approvedOwn();
    const res = await put(r.id, r.lineIds[0]!, { accountNumber: "6101" }, perms, "acct-1");
    expect([res.status, res.body["code"]]).toEqual([403, "self_approval_forbidden"]);
  });

  it("an owner with no restriction may change their own request (the policy is the same knob as approve), in both states", async () => {
    const perms = perActionGrants({ review: {}, "set-approved-total": {}, approve: {}, reclassify: {} }, null);
    const submitted = await createRequest([{ entity: "welld_ch" }], { owner: "acct-1" });
    expect((await put(submitted.id, submitted.lineIds[0]!, { accountNumber: "6101" }, perms, "acct-1")).status).toBe(200);
    const approved = await approvedOwn();
    expect((await put(approved.id, approved.lineIds[0]!, { accountNumber: "6101" }, perms, "acct-1")).status).toBe(200);
  });

  it("a non-owner with the restricted grants is not affected", async () => {
    const perms = perActionGrants({ review: {}, "set-approved-total": {}, approve: { selfDeny: true }, reclassify: { selfDeny: true } }, null);
    const approved = await approvedOwn("emp-9");
    expect((await put(approved.id, approved.lineIds[0]!, { accountNumber: "6101" }, perms, "acct-1")).status).toBe(200);
  });

  it("the check runs BEFORE the scope 404s, as approve does: an out-of-scope owner learns 403, not 404", async () => {
    const perms = perActionGrants({ review: { entity: true }, "set-approved-total": { entity: true }, approve: { entity: true, selfDeny: true } }, "welld_it");
    const r = await createRequest([{ entity: "welld_ch" }], { owner: "acct-1" }); // no welld_it line: a stranger for this scope
    const res = await put(r.id, r.lineIds[0]!, { accountNumber: "6101" }, perms, "acct-1");
    expect([res.status, res.body["code"]]).toEqual([403, "self_approval_forbidden"]);
    // a non-owner with the same grants gets the stranger's 404
    const stranger = await createRequest([{ entity: "welld_ch" }], { owner: "emp-9" });
    expect((await put(stranger.id, stranger.lineIds[0]!, { accountNumber: "6101" }, perms, "acct-1")).status).toBe(404);
  });

  it("an unknown request is still 404, never a self-approval 403", async () => {
    expect((await put("nope", "nope", { accountNumber: "6101" }, restricted, "acct-1")).status).toBe(404);
  });

  it("a paid request stays 409 classification_locked and a draft 409 not_classifiable_status: SoD is about the states that can change", async () => {
    const batch = await createBatch("paid");
    const paid = await createRequest([{ receiptNumber: "MC26/001", stored: booked() }], { owner: "acct-1", status: "paid", batchId: batch.id });
    expect((await put(paid.id, paid.lineIds[0]!, { vatCode: "NOVAT" }, restricted, "acct-1")).body["code"]).toBe("classification_locked");
    const draft = await createRequest([{}], { owner: "acct-1", status: "draft" });
    expect((await put(draft.id, draft.lineIds[0]!, { vatCode: "NOVAT" }, restricted, "acct-1")).body["code"]).toBe("not_classifiable_status");
  });

  it("the refusal is logged at info level with the actor and request ids and no personal data", async () => {
    const logged: string[] = [];
    const original = console.info;
    console.info = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    try {
      const r = await approvedOwn();
      await put(r.id, r.lineIds[0]!, { accountNumber: "6101" }, restricted, "acct-1");
      const entry = logged
        .map((l) => {
          try {
            return JSON.parse(l) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find((e) => e?.["event"] === "refund.classification_self_approval_denied");
      expect(entry).toMatchObject({ actorUserId: "acct-1", requestId: r.id });
      expect(logged.join("\n")).not.toContain("@");
    } finally {
      console.info = original;
    }
  });

  it("the view says selfRestricted for the owner under a restricted grant, in review and post_approval, and false for everyone else", async () => {
    const submitted = await createRequest([{ entity: "welld_ch" }], { owner: "acct-1" });
    const approved = await approvedOwn();
    const submittedPerms = perActionGrants({ review: {}, "set-approved-total": {}, approve: { selfDeny: true } }, null);
    harness.setResolve(async () => submittedPerms);
    __resetAuthzCacheForTests();
    expect((await view(submitted.id, "acct-1")).body["selfRestricted"]).toBe(true);
    expect((await view(submitted.id, "acct-2")).body["selfRestricted"]).toBe(false); // not the owner
    harness.setResolve(async () => restricted);
    __resetAuthzCacheForTests();
    expect((await view(approved.id, "acct-1")).body["selfRestricted"]).toBe(true);
    expect((await view(approved.id, "acct-2")).body["selfRestricted"]).toBe(false);
    harness.setResolve(async () => perActionGrants({ review: {}, "set-approved-total": {}, approve: {}, reclassify: {} }, null));
    __resetAuthzCacheForTests();
    expect((await view(approved.id, "acct-1")).body["selfRestricted"]).toBe(false); // owner, no restriction
  });

  it("selfRestricted is false where nothing can change anyway (locked, draft)", async () => {
    const batch = await createBatch("paid");
    const paid = await createRequest([{ receiptNumber: "MC26/001", stored: booked() }], { owner: "acct-1", status: "paid", batchId: batch.id });
    const draft = await createRequest([{}], { owner: "acct-1", status: "draft" });
    harness.setResolve(async () => restricted);
    __resetAuthzCacheForTests();
    expect((await view(paid.id, "acct-1")).body["selfRestricted"]).toBe(false);
    expect((await view(draft.id, "acct-1")).body["selfRestricted"]).toBe(false);
  });
});
