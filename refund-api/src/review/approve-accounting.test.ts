/**
 * What approving a request does for accounting (T12, specs/20261118-refund-accounting-export; reworked by T20,
 * specs/20261119-accounting): the release gate, the Accounting pre-read, the copies, the exchange-rate copy or "rate
 * pending", the receipt numbers and the refusals.
 *
 * Real Postgres, jwt/authz mocked (`test-support/testAuth.ts`), a FAKE `AccountingPort` (no network); the router under test
 * is `decideRouter`. The plan's rows covered here:
 *   AC-5.1  copies: defaults from the fake, a hand copy unchanged, the rate and its month, nothing on a rejected line;
 *           `line_classified` cause `approval` carries the copied values and `fxRate`
 *   AC-5.3  a frozen copy ignores later changes in Accounting and of the defaults
 *   AC-5.6  a foreign line with no rate in effect approves, "rate pending"
 *   AC-6.1  Accounting unreachable (each kind) with a non-rejected CH line, even one already classified by hand: 503
 *           `accounting_unavailable` with `Retry-After`
 *   AC-6.2  after each refusal: still submitted, no number, no counter row, no copy, no decision, no audit; a later
 *           approval succeeds
 *   AC-6.3  `classification_missing` on a type without a default, a deactivated or vanished default, an unusable designation;
 *           with Accounting also unreachable, AC-6.1 first
 *   AC-6.4  an IT-only request, and one whose CH lines are all rejected, approve with 0 fake calls
 *   AC-4.9  WellD Italia lines are numbered but never classified
 *   AC-6.10 no refusal body carries a URL, a host, an id or a stack
 *   AC-4.1 to AC-4.10 of 20261118 (numbering) and D6 (the release gate), unchanged
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { ResolveResponse } from "../authz/resolveClient";
import { markAccountingReleased } from "../test-support/accountingRelease";
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

const harness = setupTestAuth();
await harness.init();

// A query string makes this a module instance of its own: `decide.routes.test.ts` imports the same file, and a router
// created there is bound to THAT file's mocked jwt/authz (testAuth.ts, "no shared router specifier").
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { decideRouter } = (await import("./decide.routes?approve-accounting")) as typeof import("./decide.routes");
const { db } = await import("../lib/db");
const { ACCOUNTING_FAILURE_KINDS } = await import("../accounting/accountingClient");
const { createFakeAccounting, useFakeAccounting, restoreAccounting } = await import("../test-support/fakeAccounting");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { notifyTransport } = await import("../lib/notifyPost");

// The decision notification and email go to notify-api: answered here, never sent. The service-token provider
// is disabled under NODE_ENV=test, so a stub stands in for it and the push reaches the (faked) wire quietly.
const realTokens = notifyTransport.tokens;
notifyTransport.tokens = { async getToken() { return "stub-service-jwt"; }, invalidate() {} };
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (typeof url === "string" && url.includes("/system/")) return new Response(JSON.stringify({ id: "n1" }), { status: 200 });
  return originalFetch(url, init);
}) as unknown as typeof fetch;

const accountingPerms: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [
    { resource: "refund", action: "access", conditions: null },
    { resource: "request", action: "review", conditions: null },
    { resource: "request", action: "set-approved-total", conditions: null },
    { resource: "request", action: "approve", conditions: null },
    { resource: "request", action: "reject", conditions: null },
  ],
  entity: null,
  jobTitle: null,
};

const by = { createdByUserId: "admin", createdByEmail: "admin@welld.ch" };
const ACTOR_SUB = "acct-1";

const fake = createFakeAccounting();

/** AC-6.10: a refusal names the cause and carries no address, identifier or internal text. */
const NO_INTERNALS = /https?:\/\/(?!httpstatuses\.com)|localhost|railway|\bc[a-z0-9]{24}\b|\bat .*\(/;

/** Refund's recorded default of one type: a copy of the account as it was chosen (there is no VAT default). */
const recordDefault = (type: string, account: [string, string] | null, offsetMs = 0) =>
  db.expenseTypeAccountingDefault.create({
    data: {
      entity: "welld_ch",
      type: type as never,
      ...(account ? { accountNumber: account[0], accountName: account[1] } : {}),
      ...by,
      createdAt: new Date(Date.now() + offsetMs),
    },
  });
const TRAIN: [string, string] = ["5901", "Treno"];
const OFFICE: [string, string] = ["6101", "Ufficio"];
const IMP81: [string, string, number] = ["IMP81", "IVA 8.1%", 810];
const NOVAT: [string, string, number] = ["NOVAT", "Senza IVA", 0];

async function seedCatalog() {
  fake.failWith(null).failReferenceDataWith(null).failRatesWith(null).setDelayMs(0).onRead(null).resetCalls();
  for (const a of ["5901", "6101"]) fake.removeAccount(a);
  for (const v of ["IMP81", "NOVAT"]) fake.removeVatCode(v);
  for (const c of ["EUR", "USD", "GBP"] as const) for (const m of ["2025-12", "2026-01", "2026-03", "2026-04"]) fake.removeRate(c, m);
  fake.setAccount(...TRAIN).setAccount(...OFFICE).setVatCode(...IMP81).setVatCode(...NOVAT);
  useFakeAccounting(fake);
  // `stationery` deliberately has no default.
  await recordDefault("travel_train", TRAIN);
  await recordDefault("office_material", OFFICE);
  await recordDefault("postal", OFFICE);
}

beforeEach(async () => {
  await truncateRefundTables();
  __resetAuthzCacheForTests();
  harness.setResolve(async () => accountingPerms);
  await seedCatalog();
});
afterAll(async () => {
  restoreAccounting();
  await truncateRefundTables();
  notifyTransport.tokens = realTokens;
  globalThis.fetch = originalFetch;
});

interface LineSpec {
  date?: string;
  type?: "travel_train" | "office_material" | "postal" | "stationery" | "representation_gifts";
  entity?: "welld_ch" | "welld_it";
  currency?: "CHF" | "EUR" | "USD" | "GBP";
  rejected?: boolean;
  createdAt?: string;
  id?: string;
  approvedTotalCents?: number | null;
  requestedAmountCents?: number;
  /** A hand copy of the account stored before the approval (WellD CH only). */
  accountNumber?: string;
  accountName?: string;
  /** A VAT code copy stored by hand (code, rate in basis points). */
  vat?: [string, number];
}

async function createRequest(owner: { id: string; name?: string | null; email?: string }, lines: LineSpec[]) {
  const request = await db.refundRequest.create({
    data: {
      ownerUserId: owner.id,
      ownerEmail: owner.email ?? `${owner.id}@welld.ch`,
      ownerName: owner.name === undefined ? "Matteo Codogno" : owner.name,
      status: "submitted",
      submittedAt: new Date(),
    },
  });
  const ids: string[] = [];
  for (const spec of lines) {
    const line = await db.refundLine.create({
      data: {
        ...(spec.id ? { id: spec.id } : {}),
        requestId: request.id,
        date: new Date(spec.date ?? "2026-03-02"),
        type: spec.type ?? "travel_train",
        motivo: "m",
        entity: spec.entity ?? "welld_ch",
        currency: spec.currency ?? "CHF",
        requestedAmountCents: spec.requestedAmountCents ?? 1000,
        approvedTotalCents: spec.approvedTotalCents === undefined ? null : spec.approvedTotalCents,
        ...(spec.createdAt ? { createdAt: new Date(spec.createdAt) } : {}),
        ...(spec.accountNumber ? { accountNumber: spec.accountNumber, accountName: spec.accountName ?? "x", ledgerAccountIsDefault: false } : {}),
        ...(spec.vat ? { vatCodeCopy: spec.vat[0], vatRateBasisPoints: spec.vat[1], vatCodeIsDefault: false } : {}),
        ...(spec.rejected ? { rejectionReason: "no", rejectedAt: new Date(), rejectedByUserId: "a", rejectedByEmail: "a@x", approvedTotalCents: 0 } : {}),
      },
    });
    ids.push(line.id);
  }
  return { id: request.id, lineIds: ids };
}

async function approve(requestId: string) {
  const token = await harness.signToken({ sub: ACTOR_SUB, email: "acct1@welld.ch" });
  const res = await decideRouter.request(`/review/requests/${requestId}/approve`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  return { status: res.status, body: (await res.json()) as Record<string, any>, headers: res.headers };
}

const lineOf = (id: string) => db.refundLine.findUniqueOrThrow({ where: { id } });
const numbersOf = async (ids: string[]) => Promise.all(ids.map(async (id) => (await lineOf(id)).receiptNumber));
const counterOf = (owner: string, year: number) =>
  db.receiptCounter.findUnique({ where: { ownerUserId_year: { ownerUserId: owner, year } } });

describe("the release gate (D6)", () => {
  it("409 accounting_release_pending before the marker, and nothing at all is written", async () => {
    await truncateRefundTables({ released: false });
    await seedCatalog();
    const r = await createRequest({ id: "owner-1" }, [{}, { entity: "welld_it" }]);
    fake.resetCalls();

    const res = await approve(r.id);
    expect(res.status).toBe(409);
    expect(res.body["code"]).toBe("accounting_release_pending");
    expect(fake.reads.total).toBe(0); // the gate comes before Accounting is read

    const request = await db.refundRequest.findUniqueOrThrow({ where: { id: r.id } });
    expect(request.status).toBe("submitted");
    expect(request.decidedAt).toBeNull();
    expect(await db.refundAuditEntry.count()).toBe(0);
    expect(await db.receiptCounter.count()).toBe(0);
    for (const id of r.lineIds) {
      const line = await lineOf(id);
      expect(line.approvedTotalCents).toBeNull();
      expect(line.receiptNumber).toBeNull();
    }

    await markAccountingReleased();
    expect((await approve(r.id)).status).toBe(200);
    expect(await numbersOf(r.lineIds)).toEqual(["MC26/001", "MC26/002"]);
  });

  it("an IT-only request is refused by the gate too", async () => {
    await truncateRefundTables({ released: false });
    const r = await createRequest({ id: "owner-1" }, [{ entity: "welld_it", currency: "EUR" }]);
    const res = await approve(r.id);
    expect(res.status).toBe(409);
    expect(res.body["code"]).toBe("accounting_release_pending");
  });

  it("an already-decided request still answers the ordinary 409, not the gate", async () => {
    await truncateRefundTables({ released: false });
    const r = await createRequest({ id: "owner-1" }, [{}]);
    await db.refundRequest.update({ where: { id: r.id }, data: { status: "approved" } });
    const res = await approve(r.id);
    expect(res.status).toBe(409);
    expect(res.body["code"]).toBeUndefined();
  });
});

describe("approve: copies and numbering", () => {
  it("(AC-5.1, AC-4.2) copies the type's default account, numbers the line MC26/001 and audits cause approval; no VAT code", async () => {
    const r = await createRequest({ id: "owner-1" }, [{ type: "travel_train" }]);
    const res = await approve(r.id);
    expect(res.status).toBe(200);

    const line = await lineOf(r.lineIds[0]!);
    expect(line).toMatchObject({
      accountNumber: "5901",
      accountName: "Treno",
      ledgerAccountIsDefault: true,
      vatCodeCopy: null,
      vatRateBasisPoints: null,
      vatCodeIsDefault: null,
      receiptNumber: "MC26/001",
      receiptOwnerUserId: "owner-1",
      receiptYear: 2026,
      receiptSeq: 1,
      fxRateMicros: null,
    });
    expect(Object.keys(line).filter((key) => /ledgerAccountId|vatCodeId/.test(key))).toEqual([]); // the old foreign keys are gone (T24)
    expect(line.numberedAt).not.toBeNull();

    const classified = await db.refundAuditEntry.findMany({ where: { requestId: r.id, action: "line_classified" } });
    expect(classified).toHaveLength(1);
    expect(classified[0]!.actorUserId).toBe(ACTOR_SUB);
    expect(classified[0]!.lineId).toBe(r.lineIds[0]!);
    expect((classified[0]!.detail as any).v).toBe(2);
    expect((classified[0]!.detail as any).cause).toBe("approval");
    expect((classified[0]!.detail as any).account.to).toEqual({ number: "5901", name: "Treno" });
    expect((classified[0]!.detail as any).vatCode).toEqual({ from: null, to: null, fromDefault: false, toDefault: false });
    expect(classified[0]!.detail).not.toHaveProperty("fxRate"); // a CHF line has no rate
    const numbered = await db.refundAuditEntry.findMany({ where: { requestId: r.id, action: "receipt_number_assigned" } });
    expect(numbered).toHaveLength(1);
    expect(numbered[0]!.detail).toEqual({ cause: "approval", receiptNumber: "MC26/001", year: 2026, seq: 1 });
  });

  it("(AC-5.1) a request with a CH CHF line on defaults, a hand copy, an EUR line with a rate and a rejected line: each copy as the plan says", async () => {
    fake.setRate("EUR", "2026-03", 924_600);
    const r = await createRequest({ id: "owner-1" }, [
      { date: "2026-03-01", type: "travel_train" }, // on defaults
      { date: "2026-03-02", type: "travel_train", accountNumber: "6101", accountName: "Ufficio (as copied)", vat: ["IMP81", 810] }, // classified by hand earlier
      { date: "2026-03-03", type: "office_material", currency: "EUR", requestedAmountCents: 1040 }, // a rate in effect
      { date: "2026-03-04", type: "stationery", rejected: true },
    ]);
    expect((await approve(r.id)).status).toBe(200);
    const [defaults, hand, eur, rejected] = await Promise.all(r.lineIds.map(lineOf));
    expect(defaults).toMatchObject({ accountNumber: "5901", ledgerAccountIsDefault: true, vatCodeCopy: null });
    expect(hand).toMatchObject({ accountNumber: "6101", accountName: "Ufficio (as copied)", ledgerAccountIsDefault: false, vatCodeCopy: "IMP81", vatRateBasisPoints: 810, vatCodeIsDefault: false });
    expect(eur).toMatchObject({ accountNumber: "6101", vatCodeCopy: null, vatRateBasisPoints: null, fxRateMicros: 924_600 });
    expect(eur!.fxRateMonth?.toISOString().slice(0, 10)).toBe("2026-03-01");
    expect(eur!.fxRateCopiedAt).not.toBeNull();
    expect([rejected!.accountNumber, rejected!.vatCodeCopy, rejected!.fxRateMicros, rejected!.receiptNumber]).toEqual([null, null, null, null]);
    const audits = await db.refundAuditEntry.findMany({ where: { requestId: r.id, action: "line_classified" } });
    const detailOf = (id: string) => audits.find((a) => a.lineId === id)!.detail as any;
    expect(detailOf(r.lineIds[2]!).fxRate).toEqual({ rateMicros: 924_600, month: "2026-03" });
    expect(detailOf(r.lineIds[1]!).account).toEqual({ from: { number: "6101", name: "Ufficio (as copied)" }, to: { number: "6101", name: "Ufficio (as copied)" }, fromDefault: false, toDefault: false });
    expect(audits).toHaveLength(3); // the rejected line has none
  });

  it("(AC-5.6) a foreign-currency line whose month has no rate in effect approves, and is rate pending", async () => {
    fake.setRateMissing("EUR", "2026-03", "not_published");
    const r = await createRequest({ id: "owner-1" }, [{ type: "office_material", currency: "EUR" }]);
    expect((await approve(r.id)).status).toBe(200);
    const line = await lineOf(r.lineIds[0]!);
    expect(line).toMatchObject({ receiptNumber: "MC26/001", accountNumber: "6101", vatCodeCopy: null, fxRateMicros: null, fxRateMonth: null, fxRateCopiedAt: null });
    const detail = (await db.refundAuditEntry.findFirstOrThrow({ where: { lineId: r.lineIds[0]!, action: "line_classified" } })).detail as any;
    expect(detail.fxRate).toBe("pending");
  });

  it("(AC-3.11) a manual account copy on the line is what gets copied, as not-default, and the line has no VAT code", async () => {
    const r = await createRequest({ id: "owner-1" }, [{ type: "travel_train", accountNumber: "6101", accountName: "Ufficio" }]);
    expect((await approve(r.id)).status).toBe(200);
    const line = await lineOf(r.lineIds[0]!);
    expect(line.accountNumber).toBe("6101");
    expect(line.ledgerAccountIsDefault).toBe(false);
    expect(line.vatCodeCopy).toBeNull();
    expect(line.vatCodeIsDefault).toBeNull();
  });

  it("(AC-3.13 of 20261118) a non-CHF line copies the type's account and NO VAT code; one chosen by hand is kept, reverse-charge code included", async () => {
    fake.setVatCode("BZM81", "IVA 8.1% reverse charge", 810);
    const r = await createRequest({ id: "owner-1" }, [
      { date: "2026-03-02", type: "office_material", currency: "EUR" },
      { date: "2026-03-03", type: "office_material", currency: "EUR", vat: ["BZM81", 810] },
    ]);
    expect((await approve(r.id)).status).toBe(200);
    const [plain, reverse] = await Promise.all(r.lineIds.map(lineOf));
    expect(plain).toMatchObject({ accountNumber: "6101", vatCodeCopy: null, vatRateBasisPoints: null, vatCodeIsDefault: null });
    expect(reverse).toMatchObject({ accountNumber: "6101", vatCodeCopy: "BZM81", vatRateBasisPoints: 810, vatCodeIsDefault: false });
  });

  it("(AC-5.3) Accounting and the defaults changing after approval do not move the booked copy", async () => {
    fake.setRate("EUR", "2026-03", 924_600);
    const r = await createRequest({ id: "owner-1" }, [{ type: "travel_train", vat: ["IMP81", 810] }, { type: "office_material", currency: "EUR", vat: ["NOVAT", 0] }]);
    expect((await approve(r.id)).status).toBe(200);
    const before = await Promise.all(r.lineIds.map(lineOf));

    // Refund's defaults change...
    await db.expenseTypeAccountingDefault.create({
      data: { entity: "welld_ch", type: "travel_train", accountNumber: "6101", accountName: "Ufficio", ...by, createdAt: new Date(Date.now() + 1000) },
    });
    // ...and Accounting does too.
    fake.setAccountActive("5901", false);
    fake.setVatCodeActive("IMP81", false);
    fake.setAccount("6101", "Another name");
    fake.setRate("EUR", "2026-03", 950_000, "corrected");

    const after = await Promise.all(r.lineIds.map(lineOf));
    for (const [i, line] of after.entries()) {
      expect([line.accountNumber, line.accountName, line.vatCodeCopy, line.vatRateBasisPoints, line.fxRateMicros]).toEqual([
        before[i]!.accountNumber, before[i]!.accountName, before[i]!.vatCodeCopy, before[i]!.vatRateBasisPoints, before[i]!.fxRateMicros,
      ]);
      expect(line.ledgerAccountIsDefault).toBe(before[i]!.ledgerAccountIsDefault);
    }
    expect([after[0]!.vatCodeCopy, after[1]!.vatCodeCopy, after[1]!.fxRateMicros]).toEqual(["IMP81", "NOVAT", 924_600]);
  });

  it("(AC-4.1, AC-4.9) a rejected line is not numbered or classified; WellD Italia lines are numbered but never classified", async () => {
    const r = await createRequest({ id: "owner-1" }, [
      { date: "2026-03-01", type: "travel_train" },
      { date: "2026-03-02", rejected: true, type: "stationery" },
      { date: "2026-03-03", entity: "welld_it", currency: "EUR", type: "stationery" },
    ]);
    expect((await approve(r.id)).status).toBe(200);
    expect(await numbersOf(r.lineIds)).toEqual(["MC26/001", null, "MC26/002"]);

    const rejected = await lineOf(r.lineIds[1]!);
    expect(rejected.accountNumber).toBeNull();
    expect(rejected.vatCodeCopy).toBeNull();
    expect(rejected.receiptOwnerUserId).toBeNull();
    const it = await lineOf(r.lineIds[2]!);
    expect([it.accountNumber, it.accountName, it.vatCodeCopy, it.vatRateBasisPoints, it.fxRateMicros]).toEqual([null, null, null, null, null]);
    expect(it.ledgerAccountIsDefault).toBeNull();
    expect(it.vatCodeIsDefault).toBeNull();

    const classifiedLineIds = (await db.refundAuditEntry.findMany({ where: { requestId: r.id, action: "line_classified" } })).map((a) => a.lineId);
    expect(classifiedLineIds).toEqual([r.lineIds[0]!]);
    expect(await db.refundAuditEntry.count({ where: { requestId: r.id, action: "receipt_number_assigned" } })).toBe(2);
    expect((await counterOf("owner-1", 2026))!.lastSeq).toBe(2);
  });

  it("(AC-6.4) an IT-only request approves with no defaults configured at all, and without a single call to Accounting", async () => {
    await truncateRefundTables();
    fake.resetCalls();
    const r = await createRequest({ id: "owner-1" }, [
      { entity: "welld_it", currency: "EUR", type: "stationery" },
      { entity: "welld_it", currency: "EUR", type: "representation_gifts" },
    ]);
    expect((await approve(r.id)).status).toBe(200);
    expect(await numbersOf(r.lineIds)).toEqual(["MC26/001", "MC26/002"]);
    expect(fake.reads.total).toBe(0);
  });

  it("(AC-6.3, AC-4.9) a rejected WellD CH line with no default does not block the approval", async () => {
    const r = await createRequest({ id: "owner-1" }, [{ type: "travel_train" }, { type: "stationery", rejected: true }]);
    expect((await approve(r.id)).status).toBe(200);
  });

  it("a line approved at 0 and not rejected is classified and numbered like any other", async () => {
    const r = await createRequest({ id: "owner-1" }, [{ approvedTotalCents: 0 }]);
    expect((await approve(r.id)).status).toBe(200);
    const line = await lineOf(r.lineIds[0]!);
    expect(line.approvedTotalCents).toBe(0);
    expect(line.receiptNumber).toBe("MC26/001");
    expect(line.vatCodeCopy).toBeNull();
  });

  it("AC-7.2 of the old spec still holds: untouched lines default to the requested amount", async () => {
    const r = await createRequest({ id: "owner-1" }, [{ requestedAmountCents: 4200 }, { approvedTotalCents: 300 }]);
    expect((await approve(r.id)).status).toBe(200);
    expect((await lineOf(r.lineIds[0]!)).approvedTotalCents).toBe(4200);
    expect((await lineOf(r.lineIds[1]!)).approvedTotalCents).toBe(300);
  });
});

describe("the pre-read of Accounting (D10, D11, AC-4.8, AC-6.4)", () => {
  it("reads Accounting ONCE per approval: the reference data, and the rates of every foreign CH line as one pair set, before the transaction", async () => {
    fake.setRate("EUR", "2026-03", 924_600).setRate("USD", "2026-03", 780_800);
    const r = await createRequest({ id: "owner-1" }, [
      { type: "office_material", currency: "EUR", date: "2026-03-02" },
      { type: "office_material", currency: "EUR", date: "2026-03-09" },
      { type: "office_material", currency: "USD", date: "2026-03-10" },
      { type: "travel_train" },
    ]);
    fake.resetCalls();
    expect((await approve(r.id)).status).toBe(200);
    expect(fake.reads).toEqual({ referenceData: 1, rates: 1, total: 2 });
    expect(fake.calls.find((c) => c.read === "rates")!.pairs!.slice().sort()).toEqual(["EUR:2026-03", "USD:2026-03"]);
    expect(fake.calls.every((c) => c.operation === "approve")).toBe(true);
  });

  it("asks for the rates of a REJECTED foreign line too (the superset: a restore between the read and the lock stays covered)", async () => {
    const r = await createRequest({ id: "owner-1" }, [{ type: "travel_train" }, { type: "office_material", currency: "GBP", date: "2026-01-12", rejected: true }]);
    fake.resetCalls();
    expect((await approve(r.id)).status).toBe(200);
    expect(fake.calls.find((c) => c.read === "rates")!.pairs).toEqual(["GBP:2026-01"]);
  });

  it("a CHF-only request reads the reference data and no rate", async () => {
    const r = await createRequest({ id: "owner-1" }, [{ type: "travel_train" }]);
    fake.resetCalls();
    await approve(r.id);
    expect(fake.reads).toEqual({ referenceData: 1, rates: 0, total: 1 });
  });

  it("(D10) a request whose only CH line is already classified by hand STILL reads Accounting: literally AC-6.1", async () => {
    const r = await createRequest({ id: "owner-1" }, [{ type: "travel_train", accountNumber: "6101", accountName: "Ufficio" }]);
    await db.refundLine.update({ where: { id: r.lineIds[0]! }, data: { vatCodeCopy: "IMP81", vatRateBasisPoints: 810, vatCodeIsDefault: false } });
    fake.resetCalls();
    expect((await approve(r.id)).status).toBe(200);
    expect(fake.reads.referenceData).toBe(1);
  });

  it("(AC-4.8) nothing is cached across approvals: the second sees a change made after the first", async () => {
    const a = await createRequest({ id: "owner-1" }, [{ type: "travel_train" }]);
    const b = await createRequest({ id: "owner-2", name: "Marta Conti" }, [{ type: "travel_train" }]);
    expect((await approve(a.id)).status).toBe(200);
    fake.setAccountActive("5901", false);
    const refused = await approve(b.id);
    expect([refused.status, refused.body["code"]]).toEqual([409, "classification_missing"]);
    expect(fake.reads.referenceData).toBeGreaterThanOrEqual(2);
  });
});

describe("(AC-6.1, AC-6.2, AC-6.8) Accounting unreachable", () => {
  async function expectNothingWritten(requestId: string, lineIds: string[]) {
    const request = await db.refundRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(request.status).toBe("submitted");
    expect(request.decidedAt).toBeNull();
    expect(request.decidedByUserId).toBeNull();
    expect(await db.refundAuditEntry.count()).toBe(0);
    expect(await db.receiptCounter.count()).toBe(0);
    for (const id of lineIds) {
      const line = await lineOf(id);
      expect(line.approvedTotalCents).toBeNull();
      expect(line.receiptNumber).toBeNull();
      expect([line.fxRateMicros, line.fxRateMonth]).toEqual([null, null]);
    }
  }

  for (const kind of ACCOUNTING_FAILURE_KINDS) {
    it(`${kind}: 503 accounting_unavailable with Retry-After, nothing written, and a later approval succeeds`, async () => {
      const r = await createRequest({ id: "owner-1" }, [{ type: "travel_train" }, { type: "office_material", currency: "EUR" }]);
      fake.failWith(kind);
      const res = await approve(r.id);
      expect([res.status, res.body["code"], res.headers.get("Retry-After")]).toEqual([503, "accounting_unavailable", "30"]);
      expect(JSON.stringify(res.body)).not.toMatch(NO_INTERNALS);
      await expectNothingWritten(r.id, r.lineIds);
      for (const id of r.lineIds) expect((await lineOf(id)).accountNumber).toBeNull(); // no copy

      fake.failWith(null);
      expect((await approve(r.id)).status).toBe(200);
      expect(await numbersOf(r.lineIds)).toEqual(["MC26/001", "MC26/002"]);
    });
  }

  it("(D10) a CH line already classified by hand does not help: unreachable is still 503", async () => {
    const r = await createRequest({ id: "owner-1" }, [{ type: "travel_train", accountNumber: "6101", accountName: "Ufficio" }]);
    await db.refundLine.update({ where: { id: r.lineIds[0]! }, data: { vatCodeCopy: "IMP81", vatRateBasisPoints: 810, vatCodeIsDefault: false } });
    fake.failWith("timeout");
    expect((await approve(r.id)).status).toBe(503);
    await expectNothingWritten(r.id, r.lineIds);
  });

  it("only the rates failing is also a 503: the pair set is part of the pre-read", async () => {
    const r = await createRequest({ id: "owner-1" }, [{ type: "office_material", currency: "EUR" }]);
    fake.failRatesWith("http_status");
    expect((await approve(r.id)).status).toBe(503);
    await expectNothingWritten(r.id, r.lineIds);
  });

  it("(AC-6.3) Accounting unreachable AND a missing default: the 503 comes first (AC-6.1)", async () => {
    const r = await createRequest({ id: "owner-1" }, [{ type: "stationery" }]);
    fake.failWith("network");
    expect((await approve(r.id)).status).toBe(503);
  });

  it("(AC-6.4) an IT-only request, and one whose CH lines are all rejected, approve while Accounting is unreachable, with 0 calls", async () => {
    fake.failWith("timeout");
    const it = await createRequest({ id: "owner-1" }, [{ entity: "welld_it", currency: "EUR" }]);
    const rejected = await createRequest({ id: "owner-2", name: "Marta Conti" }, [
      { type: "stationery", rejected: true },
      { entity: "welld_it", currency: "EUR" },
    ]);
    fake.resetCalls();
    expect((await approve(it.id)).status).toBe(200);
    expect((await approve(rejected.id)).status).toBe(200);
    expect(fake.reads.total).toBe(0);
    expect(await numbersOf(rejected.lineIds)).toEqual([null, "MC26/001"]);
  });

  it("the refusals that need no Accounting win over the 503: a stranger's request, the release gate, a decided request", async () => {
    fake.failWith("timeout");
    // not found
    expect((await approve("nope")).status).toBe(404);
    // already decided
    const done = await createRequest({ id: "owner-1" }, [{}]);
    await db.refundRequest.update({ where: { id: done.id }, data: { status: "approved" } });
    expect((await approve(done.id)).status).toBe(409);
    // the release gate
    await truncateRefundTables({ released: false });
    const gated = await createRequest({ id: "owner-1" }, [{}]);
    fake.resetCalls();
    const res = await approve(gated.id);
    expect([res.status, res.body["code"]]).toEqual([409, "accounting_release_pending"]);
    expect(fake.reads.total).toBe(0);
  });
});

describe("(AC-6.3) classification_missing", () => {
  async function expectNothingChanged(requestId: string, lineIds: string[]) {
    const request = await db.refundRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(request.status).toBe("submitted");
    expect(request.decidedAt).toBeNull();
    expect(request.decidedByUserId).toBeNull();
    expect(await db.refundAuditEntry.count()).toBe(0);
    expect(await db.receiptCounter.count()).toBe(0);
    for (const id of lineIds) {
      const line = await lineOf(id);
      expect(line.approvedTotalCents).toBeNull(); // the defaulting of untouched lines rolled back too
      expect(line.receiptNumber).toBeNull();
      expect(line.accountNumber).toBeNull();
      expect(line.vatCodeCopy).toBeNull();
    }
  }

  it("a type without a default: 409 listing that line with id, date and type; nothing changes", async () => {
    const r = await createRequest({ id: "owner-1" }, [
      { date: "2026-03-01", type: "travel_train" },
      { date: "2026-03-05", type: "stationery" },
      { date: "2026-03-06", entity: "welld_it", currency: "EUR" },
    ]);
    const res = await approve(r.id);
    expect(res.status).toBe(409);
    expect(res.body["code"]).toBe("classification_missing");
    expect(res.body["status"]).toBe(409);
    expect(res.body["lines"]).toEqual([
      { lineId: r.lineIds[1]!, date: "2026-03-05", type: "stationery", missing: ["account"] },
    ]);
    await expectNothingChanged(r.id, r.lineIds);
  });

  it("(AC-8.4 of 20261118) a representation_gifts line (no default account) is refused until an account is chosen, then approves with no VAT code", async () => {
    const r = await createRequest({ id: "owner-1" }, [{ date: "2026-03-01", type: "representation_gifts" }, { date: "2026-03-02", type: "representation_gifts", currency: "EUR" }]);
    await recordDefault("representation_gifts", null); // the settings state at release: a row that names no account
    const res = await approve(r.id);
    expect(res.status).toBe(409);
    expect(res.body["lines"]).toEqual([
      { lineId: r.lineIds[0]!, date: "2026-03-01", type: "representation_gifts", missing: ["account"] },
      { lineId: r.lineIds[1]!, date: "2026-03-02", type: "representation_gifts", missing: ["account"] },
    ]);
    await expectNothingChanged(r.id, r.lineIds);

    await db.refundLine.updateMany({ where: { requestId: r.id }, data: { accountNumber: "6101", accountName: "Ufficio", ledgerAccountIsDefault: false } });
    expect((await approve(r.id)).status).toBe(200);
    expect((await lineOf(r.lineIds[0]!)).vatCodeCopy).toBeNull();
  });

  it("(AC-3.4, AC-3.11) the 409 lists `missing: [\"account\"]` only, and never a line merely lacking a VAT code, in CHF or EUR", async () => {
    const r = await createRequest({ id: "owner-1" }, [
      { date: "2026-03-01", type: "travel_train" },
      { date: "2026-03-02", type: "office_material", currency: "EUR" },
      { date: "2026-03-03", type: "stationery", currency: "USD" },
    ]);
    const res = await approve(r.id);
    expect(res.status).toBe(409);
    expect(res.body["lines"]).toEqual([{ lineId: r.lineIds[2]!, date: "2026-03-03", type: "stationery", missing: ["account"] }]);
    expect(JSON.stringify(res.body)).not.toContain("vatCode");
  });

  it("a type whose default ACCOUNT was deactivated in Accounting counts as missing (G3, AC-4.5)", async () => {
    fake.setAccountActive("5901", false);
    const r = await createRequest({ id: "owner-1" }, [{ type: "travel_train" }]);
    const res = await approve(r.id);
    expect(res.status).toBe(409);
    expect(res.body["lines"]).toEqual([{ lineId: r.lineIds[0]!, date: "2026-03-02", type: "travel_train", missing: ["account"] }]);
    expect(String(res.body["detail"])).not.toMatch(NO_INTERNALS); // the lines are named by id, as the contract says; the message is generic
    await expectNothingChanged(r.id, r.lineIds);

    // reactivation brings the default back (AC-1.9): the same request then approves
    fake.setAccountActive("5901", true);
    expect((await approve(r.id)).status).toBe(200);
  });

  it("a default account that is no longer found in Accounting counts as missing too (SA-3)", async () => {
    fake.removeAccount("5901");
    const r = await createRequest({ id: "owner-1" }, [{ type: "travel_train" }]);
    const res = await approve(r.id);
    expect([res.status, res.body["lines"]]).toEqual([409, [{ lineId: r.lineIds[0]!, date: "2026-03-02", type: "travel_train", missing: ["account"] }]]);
    await expectNothingChanged(r.id, r.lineIds);
  });

  it("(AC-3.11) a VAT code that is missing, deactivated or never chosen never holds an approval back, in any currency", async () => {
    fake.removeVatCode("IMP81");
    fake.setVatCodeActive("NOVAT", false);
    const eur = await createRequest({ id: "owner-1" }, [{ type: "office_material", currency: "EUR" }]);
    expect((await approve(eur.id)).status).toBe(200);
    const usd = await createRequest({ id: "owner-2" }, [{ type: "office_material", currency: "USD" }]);
    expect((await approve(usd.id)).status).toBe(200);
    const chf = await createRequest({ id: "owner-3" }, [{ type: "office_material", currency: "CHF" }]);
    expect((await approve(chf.id)).status).toBe(200);
    for (const id of [...eur.lineIds, ...usd.lineIds, ...chf.lineIds]) expect((await lineOf(id)).vatCodeCopy).toBeNull();
  });

  it("a hand copy rescues a line with no usable default, even when its entry is deactivated since (the copy is what it books)", async () => {
    fake.setAccountActive("5901", false);
    const r = await createRequest({ id: "owner-1" }, [{ type: "travel_train", accountNumber: "5901", accountName: "Treno" }]);
    expect((await approve(r.id)).status).toBe(200);
    expect(await lineOf(r.lineIds[0]!)).toMatchObject({ accountNumber: "5901", accountName: "Treno", ledgerAccountIsDefault: false });
  });

  it("a refusal consumes no number (AC-4.3): the next approval of the same employee still starts at 001", async () => {
    const bad = await createRequest({ id: "owner-1" }, [{ date: "2026-03-01" }, { date: "2026-03-02", type: "stationery" }, { entity: "welld_it", currency: "EUR" }]);
    expect((await approve(bad.id)).status).toBe(409);
    expect(await db.receiptCounter.count()).toBe(0);

    const good = await createRequest({ id: "owner-1" }, [{ date: "2026-03-03" }]);
    expect((await approve(good.id)).status).toBe(200);
    expect(await numbersOf(good.lineIds)).toEqual(["MC26/001"]);
    expect((await counterOf("owner-1", 2026))!.lastSeq).toBe(1);
  });

  it("rejecting the unclassifiable line lets the rest approve", async () => {
    const r = await createRequest({ id: "owner-1" }, [{ type: "travel_train" }, { type: "stationery" }]);
    expect((await approve(r.id)).status).toBe(409);
    await db.refundLine.update({
      where: { id: r.lineIds[1]! },
      data: { rejectionReason: "no", rejectedAt: new Date(), rejectedByUserId: "a", rejectedByEmail: "a@x", approvedTotalCents: 0 },
    });
    expect((await approve(r.id)).status).toBe(200);
  });
});

describe("numbering through approve", () => {
  it("(AC-4.3) three successive approvals are 001..n and the counter equals the highest", async () => {
    const a = await createRequest({ id: "owner-1" }, [{ date: "2026-03-02" }, { date: "2026-03-03" }]);
    const b = await createRequest({ id: "owner-1" }, [{ date: "2026-03-01" }]);
    const c = await createRequest({ id: "owner-1" }, [{ date: "2026-04-01" }, { date: "2026-04-02" }]);
    for (const r of [a, b, c]) expect((await approve(r.id)).status).toBe(200);
    expect(await numbersOf(a.lineIds)).toEqual(["MC26/001", "MC26/002"]);
    expect(await numbersOf(b.lineIds)).toEqual(["MC26/003"]);
    expect(await numbersOf(c.lineIds)).toEqual(["MC26/004", "MC26/005"]);
    expect((await counterOf("owner-1", 2026))!.lastSeq).toBe(5);
  });

  it("(AC-4.4) lines created in the order 03-10, 03-02, 03-02' are numbered 03-02, 03-02', 03-10; equal createdAt falls to the id", async () => {
    const r = await createRequest({ id: "owner-1" }, [
      { date: "2026-03-10", id: "line-a" },
      { date: "2026-03-02", id: "line-b", createdAt: "2026-03-05T10:00:00Z" },
      { date: "2026-03-02", id: "line-c", createdAt: "2026-03-05T10:00:01Z" },
      { date: "2026-03-02", id: "line-0", createdAt: "2026-03-05T10:00:01Z" },
    ]);
    expect((await approve(r.id)).status).toBe(200);
    expect(await numbersOf(["line-b", "line-0", "line-c", "line-a"])).toEqual(["MC26/001", "MC26/002", "MC26/003", "MC26/004"]);
  });

  it("(AC-4.5) lines dated 2025-12-30 and 2026-01-02 are 25/001 and 26/001", async () => {
    const r = await createRequest({ id: "owner-1", name: "Xavier Yates" }, [{ date: "2026-01-02" }, { date: "2025-12-30" }]);
    expect((await approve(r.id)).status).toBe(200);
    expect(await numbersOf(r.lineIds)).toEqual(["XY26/001", "XY25/001"]);
    expect((await counterOf("owner-1", 2025))!.lastSeq).toBe(1);
    expect((await counterOf("owner-1", 2026))!.lastSeq).toBe(1);
  });

  it("(AC-4.6) two employees with the same initials each start at 001", async () => {
    const a = await createRequest({ id: "owner-1", name: "Matteo Codogno" }, [{}]);
    const b = await createRequest({ id: "owner-2", name: "Marta Conti" }, [{}]);
    expect((await approve(a.id)).status).toBe(200);
    expect((await approve(b.id)).status).toBe(200);
    expect(await numbersOf([...a.lineIds, ...b.lineIds])).toEqual(["MC26/001", "MC26/001"]);
  });

  it("(AC-4.2/4.8) a missing display name falls back to the e-mail for the initials", async () => {
    const r = await createRequest({ id: "owner-1", name: null, email: "anna.rossi@welld.ch" }, [{}]);
    expect((await approve(r.id)).status).toBe(200);
    expect(await numbersOf(r.lineIds)).toEqual(["AR26/001"]);
  });

  it("(AC-4.10) two parallel approvals of the same employee: distinct, contiguous numbers, 20 rounds", async () => {
    for (let round = 0; round < 20; round++) {
      const owner = { id: `owner-p${round}` };
      const a = await createRequest(owner, [{ date: "2026-03-02" }, { date: "2026-03-03" }, { date: "2025-12-31" }]);
      const b = await createRequest(owner, [{ date: "2026-03-01" }, { date: "2026-03-04" }]);
      const [ra, rb] = await Promise.all([approve(a.id), approve(b.id)]);
      expect([ra.status, rb.status]).toEqual([200, 200]);
      const all = (await numbersOf([...a.lineIds, ...b.lineIds])) as string[];
      expect(new Set(all).size).toBe(5);
      const seq2026 = all.filter((n) => n.startsWith("MC26/")).map((n) => Number(n.slice(5))).sort((x, y) => x - y);
      expect(seq2026).toEqual([1, 2, 3, 4]);
      expect(all.filter((n) => n.startsWith("MC25/"))).toEqual(["MC25/001"]);
      expect((await counterOf(owner.id, 2026))!.lastSeq).toBe(4);
      expect((await counterOf(owner.id, 2025))!.lastSeq).toBe(1);
    }
  });

  it("two approvals of the SAME request: one wins, the number is issued once", async () => {
    for (let round = 0; round < 5; round++) {
      const r = await createRequest({ id: `owner-s${round}` }, [{ date: "2026-03-02" }, { date: "2026-03-03" }]);
      const results = await Promise.all([approve(r.id), approve(r.id)]);
      expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
      expect(await numbersOf(r.lineIds)).toEqual(["MC26/001", "MC26/002"]);
      expect((await counterOf(`owner-s${round}`, 2026))!.lastSeq).toBe(2);
      expect(await db.refundAuditEntry.count({ where: { requestId: r.id, action: "receipt_number_assigned" } })).toBe(2);
    }
  });
});
