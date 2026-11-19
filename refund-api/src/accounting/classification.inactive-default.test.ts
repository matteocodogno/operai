/**
 * "A default Accounting no longer offers counts as missing", in every place a line is resolved (T19, specs/20261118-
 * refund-accounting-export; reworked by T19 and T20, specs/20261119-accounting; AC-4.5 with SA-3, AC-6.3, AC-4.3, AC-1.4,
 * AC-1.8, AC-5.3; plan G3, G8a and § Test strategy "Extra tests").
 *
 * `resolveClassification` is ONE function behind the places that must never disagree: the review view, the approval, the
 * release backfill and the export blockers (T4's header). The unit vectors of `classification.test.ts` prove the function.
 * This file proves the PLACES, on the view and the PUT, with a fake Accounting: a type default that points at a
 * deactivated or vanished entry is reported WITH its state and `isDefault: true` (never `null`), cannot be chosen again,
 * and comes back by itself on reactivation, while a copy already STORED on a line is kept and shown with its present
 * state. Real Postgres, jwt/authz mocked, no network.
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
process.env["NOTIFY_INTERNAL_URL"] = "http://localhost:8081";
process.env["ACCOUNTING_INTERNAL_URL"] = "http://localhost:8089";
process.env["SERVICE_CLIENT_ID"] = "refund-api";
process.env["SERVICE_CLIENT_SECRET"] = "test-service-client-secret-at-least-32-characters";

const harness = setupTestAuth();
await harness.init();

// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { classificationRouter } = (await import("./classification.routes?inactive-default")) as typeof import("./classification.routes");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { createFakeAccounting, useFakeAccounting, restoreAccounting } = await import("../test-support/fakeAccounting");

const ACCOUNTING: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [
    { resource: "refund", action: "access", conditions: null },
    { resource: "request", action: "review", conditions: null },
    { resource: "request", action: "set-approved-total", conditions: null },
    { resource: "request", action: "approve", conditions: null },
    { resource: "request", action: "reject", conditions: null },
    { resource: "request", action: "reclassify", conditions: null },
  ],
  entity: null,
  jobTitle: null,
};

const by = { createdByUserId: "admin", createdByEmail: "admin@welld.ch" };
const fake = createFakeAccounting();

beforeEach(async () => {
  await truncateRefundTables();
  __resetAuthzCacheForTests();
  harness.setResolve(async () => ACCOUNTING);
  fake.failWith(null).failReferenceDataWith(null).failRatesWith(null).setDelayMs(0).onRead(null).resetCalls();
  for (const a of ["5901", "6101"]) fake.removeAccount(a);
  for (const v of ["IMP81", "NOVAT"]) fake.removeVatCode(v);
  fake.setAccount("5901", "Spese viaggi in treno").setAccount("6101", "Spese materiale ufficio").setVatCode("IMP81", "IVA 8.1%", 810).setVatCode("NOVAT", "Senza IVA", 0);
  useFakeAccounting(fake);
  await db.expenseTypeAccountingDefault.create({
    data: { entity: "welld_ch", type: "travel_train", accountNumber: "5901", accountName: "Spese viaggi in treno", vatCode: "IMP81", vatLabel: "IVA 8.1%", vatRateBasisPoints: 810, ...by },
  });
  await db.expenseTypeAccountingDefault.create({
    data: { entity: "welld_ch", type: "office_material", accountNumber: "6101", accountName: "Spese materiale ufficio", vatCode: "IMP81", vatLabel: "IVA 8.1%", vatRateBasisPoints: 810, ...by },
  });
  await db.foreignCurrencyVatDesignation.create({ data: { entity: "welld_ch", vatCode: "NOVAT", vatLabel: "Senza IVA", vatRateBasisPoints: 0, ...by } });
});
afterAll(async () => {
  restoreAccounting();
  await truncateRefundTables();
});

async function call(path: string, init: RequestInit = {}) {
  const token = await harness.signToken({ sub: "acct-1", email: "acct-1@welld.ch" });
  const res = await classificationRouter.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  return { status: res.status, body: (isJson && text ? JSON.parse(text) : null) as Record<string, any> | null };
}
const view = (requestId: string) => call(`/review/requests/${requestId}/accounting`);
const put = (requestId: string, lineId: string, body: object) =>
  call(`/review/requests/${requestId}/lines/${lineId}/classification`, { method: "PUT", body: JSON.stringify(body) });

async function submittedRequest(lines: { type: "travel_train" | "office_material"; currency?: "CHF" | "EUR" }[]) {
  const request = await db.refundRequest.create({
    data: { ownerUserId: "owner-1", ownerEmail: "owner-1@welld.ch", ownerName: "Matteo Codogno", status: "submitted", submittedAt: new Date() },
  });
  const lineIds: string[] = [];
  for (const [i, spec] of lines.entries()) {
    const line = await db.refundLine.create({
      data: {
        requestId: request.id,
        date: new Date("2026-03-02"),
        type: spec.type,
        motivo: "m",
        entity: "welld_ch",
        currency: spec.currency ?? "CHF",
        requestedAmountCents: 2080,
        createdAt: new Date(Date.UTC(2026, 2, 5, 10, 0, i)),
      },
    });
    lineIds.push(line.id);
  }
  return { id: request.id, lineIds };
}

const lineOf = (id: string) => db.refundLine.findUniqueOrThrow({ where: { id } });

describe("the review view and the PUT agree on a default Accounting no longer offers (G8a, AC-4.5, AC-4.3)", () => {
  it("a deactivated default account: the view reports it with its state and isDefault true, never null; the VAT half is untouched", async () => {
    const r = await submittedRequest([{ type: "travel_train" }, { type: "office_material" }]);
    fake.setAccountActive("5901", false);

    const [trainLine, officeLine] = (await view(r.id)).body!["lines"] as any[];
    expect(trainLine.classification).toEqual({
      account: { number: "5901", name: "Spese viaggi in treno", state: "deactivated" },
      accountIsDefault: true,
      vatCode: { code: "IMP81", label: "IVA 8.1%", ratePercent: "8.1", state: "active" },
      vatCodeIsDefault: true,
    });
    expect(officeLine.classification.account).toMatchObject({ number: "6101", state: "active" });
  });

  it("a default that vanished from Accounting is reported not_found, as recorded (SA-3)", async () => {
    const r = await submittedRequest([{ type: "travel_train" }]);
    fake.removeAccount("5901");
    expect((await view(r.id)).body!["lines"][0].classification.account).toEqual({ number: "5901", name: "Spese viaggi in treno", state: "not_found" });
  });

  it("the deactivated account cannot be chosen again (AC-4.3, AC-1.4): the PUT is 422, and nothing is stored", async () => {
    const r = await submittedRequest([{ type: "travel_train" }]);
    fake.setAccountActive("5901", false);
    const refused = await put(r.id, r.lineIds[0]!, { accountNumber: "5901" });
    expect([refused.status, refused.body!["code"]]).toEqual([422, "ledger_account_inactive"]);
    expect((await lineOf(r.lineIds[0]!)).accountNumber).toBeNull();
  });

  it("accounting names an account on the line: the copy is shown as chosen, and the deactivated default no longer matters", async () => {
    const r = await submittedRequest([{ type: "travel_train" }]);
    fake.setAccountActive("5901", false);
    expect((await put(r.id, r.lineIds[0]!, { accountNumber: "6101" })).status).toBe(200);
    expect((await view(r.id)).body!["lines"][0].classification).toMatchObject({
      account: { number: "6101", state: "active" },
      accountIsDefault: false,
      vatCode: { code: "IMP81" },
      vatCodeIsDefault: true,
    });
  });

  it("reactivated, the default is back in the view as a default (AC-1.9)", async () => {
    const r = await submittedRequest([{ type: "travel_train" }]);
    fake.setAccountActive("5901", false);
    expect((await view(r.id)).body!["lines"][0].classification.account.state).toBe("deactivated");
    fake.setAccountActive("5901", true);
    expect((await view(r.id)).body!["lines"][0].classification).toMatchObject({ account: { number: "5901", state: "active" }, accountIsDefault: true });
  });

  it("the same holds for a deactivated default VAT code, and for a deactivated foreign-currency designation (AC-4.5)", async () => {
    const r = await submittedRequest([{ type: "travel_train" }, { type: "office_material", currency: "EUR" }]);
    fake.setVatCodeActive("IMP81", false); // the type default of the CHF line
    fake.setVatCodeActive("NOVAT", false); // the designation used by the EUR line
    const [chf, eur] = (await view(r.id)).body!["lines"] as any[];
    expect(chf.classification.vatCode).toMatchObject({ code: "IMP81", state: "deactivated" });
    expect(eur.classification.vatCode).toMatchObject({ code: "NOVAT", state: "deactivated" });
    expect([chf.vatAmountCents, eur.vatAmountCents]).toEqual([null, null]);
  });

  it("a copy on a line whose entry was deactivated afterwards is kept, shown with the state, and the line still prices from its copied rate (AC-5.3)", async () => {
    const request = await db.refundRequest.create({
      data: { ownerUserId: "owner-1", ownerEmail: "owner-1@welld.ch", ownerName: "Matteo Codogno", status: "approved", decidedAt: new Date() },
    });
    const line = await db.refundLine.create({
      data: {
        requestId: request.id,
        date: new Date("2026-03-02"),
        type: "travel_train",
        motivo: "m",
        entity: "welld_ch",
        currency: "CHF",
        requestedAmountCents: 2080,
        approvedTotalCents: 2080,
        accountNumber: "5901",
        accountName: "Spese viaggi in treno",
        ledgerAccountIsDefault: true,
        vatCodeCopy: "IMP81",
        vatRateBasisPoints: 810,
        vatCodeIsDefault: true,
        receiptNumber: "MC26/001",
        receiptOwnerUserId: "owner-1",
        receiptYear: 2026,
        receiptSeq: 1,
        numberedAt: new Date(),
      },
    });
    fake.setAccountActive("5901", false);
    fake.setVatCodeActive("IMP81", false);
    const shown = (await view(request.id)).body!["lines"][0];
    expect(shown.classification).toMatchObject({ account: { number: "5901", state: "deactivated" }, vatCode: { code: "IMP81", state: "deactivated" } });
    expect(shown.vatAmountCents).toBe(156); // booked at 8.1 %: the copy's rate, not Accounting's present state
    expect(await lineOf(line.id)).toMatchObject({ accountNumber: "5901", vatCodeCopy: "IMP81" });
  });
});
