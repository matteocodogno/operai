/**
 * "A default Accounting no longer offers counts as missing", in every place a line is resolved (T19, specs/20261118-
 * refund-accounting-export; reworked by T19 and T20, specs/20261119-accounting; AC-4.5 with SA-3, AC-6.3, AC-4.3, AC-1.4,
 * AC-1.8, AC-5.3; plan G3, G8a and § Test strategy "Extra tests").
 *
 * `resolveClassification` is ONE function behind the places that must never disagree: the review view, the approval, the
 * release backfill and the export blockers (T4's header). The unit vectors of `classification.test.ts` prove the function.
 * This file proves the PLACES, on the view, the PUT, the approval, the release and the export, with a fake Accounting
 * (the release and export rows came back with T22 and T21 of 20261119). A type default that points at a
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

// The approval notifies the owner (best effort); answered here, never sent.
const { notifyTransport } = await import("../lib/notifyPost");
const realTokens = notifyTransport.tokens;
notifyTransport.tokens = { async getToken() { return "stub-service-jwt"; }, invalidate() {} };
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (typeof url === "string" && url.includes("/system/")) return new Response(JSON.stringify({ id: "n1" }), { status: 200 });
  return originalFetch(url, init);
}) as unknown as typeof fetch;

// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { decideRouter } = (await import("../review/decide.routes?inactive-default")) as typeof import("../review/decide.routes");
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { classificationRouter } = (await import("./classification.routes?inactive-default")) as typeof import("./classification.routes");
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { createExportRouter } = (await import("./export.routes?inactive-default")) as typeof import("./export.routes");
const { parseDefaults, runAccountingRelease } = await import("../../scripts/accounting-release");
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
  // Accounts only: there is no VAT default and no designation (20261118 SO-2, SO-16).
  await db.expenseTypeAccountingDefault.create({ data: { entity: "welld_ch", type: "travel_train", accountNumber: "5901", accountName: "Spese viaggi in treno", ...by } });
  await db.expenseTypeAccountingDefault.create({ data: { entity: "welld_ch", type: "office_material", accountNumber: "6101", accountName: "Spese materiale ufficio", ...by } });
});
afterAll(async () => {
  restoreAccounting();
  await truncateRefundTables();
  notifyTransport.tokens = realTokens;
  globalThis.fetch = originalFetch;
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
const approve = async (requestId: string) => {
  const token = await harness.signToken({ sub: "acct-1", email: "acct-1@welld.ch" });
  const res = await decideRouter.request(`/review/requests/${requestId}/approve`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const put = (requestId: string, lineId: string, body: object) =>
  call(`/review/requests/${requestId}/lines/${lineId}/classification`, { method: "PUT", body: JSON.stringify(body) });

const exportRouter = createExportRouter({ accounting: { begin: (name) => fake.begin(name) } });
async function callExport(path: string) {
  const token = await harness.signToken({ sub: "acct-1", email: "acct-1@welld.ch" });
  const res = await exportRouter.request(path, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  return { status: res.status, body: (res.headers.get("content-type") ?? "").includes("json") && text ? (JSON.parse(text) as Record<string, any>) : null };
}
const exportSummary = (batchId: string) => callExport(`/batches/${batchId}/accounting-export`);
const exportFile = (batchId: string) => callExport(`/batches/${batchId}/accounting-export/file`);

/** A legacy approved request in a compiled batch: lines with no number and no classification (what the release backfills). */
async function legacyBatch(types: ("travel_train" | "office_material")[]) {
  const batch = await db.refundBatch.create({
    data: { cutoff: new Date("2026-03-31T21:59:59.000Z"), status: "compiled", createdByUserId: "a", createdByEmail: "a@welld.ch", pdfObjectKey: `refund/batches/${crypto.randomUUID()}/compiled.pdf` },
  });
  const request = await db.refundRequest.create({
    data: {
      ownerUserId: "owner-1",
      ownerEmail: "owner-1@welld.ch",
      ownerName: "Matteo Codogno",
      status: "approved",
      submittedAt: new Date("2026-03-01"),
      decidedAt: new Date("2026-03-20"),
      decidedByUserId: "a",
      decidedByEmail: "a@welld.ch",
      batchId: batch.id,
    },
  });
  const lineIds: string[] = [];
  for (const [i, type] of types.entries()) {
    const line = await db.refundLine.create({
      data: { requestId: request.id, date: new Date("2026-03-02"), type, motivo: "m", entity: "welld_ch", currency: "CHF", requestedAmountCents: 2080, approvedTotalCents: 2080, createdAt: new Date(Date.UTC(2026, 2, 5, 10, 0, i)) },
    });
    lineIds.push(line.id);
  }
  await db.refundBatchItem.create({ data: { batchId: batch.id, requestId: request.id } });
  return { batchId: batch.id, requestId: request.id, lineIds };
}
/** The release with no defaults of its own to seed: Refund's rows of `beforeEach` are the defaults. */
const release = () =>
  runAccountingRelease({
    defaults: parseDefaults({ typeDefaults: {} }),
    accounting: { begin: (name) => fake.begin(name) },
    now: () => new Date("2026-11-20T08:00:00Z"),
  });

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
  it("a deactivated default account: the view reports it with its state and isDefault true, never null; there is no VAT half", async () => {
    const r = await submittedRequest([{ type: "travel_train" }, { type: "office_material" }]);
    fake.setAccountActive("5901", false);

    const [trainLine, officeLine] = (await view(r.id)).body!["lines"] as any[];
    expect(trainLine.classification).toEqual({
      account: { number: "5901", name: "Spese viaggi in treno", state: "deactivated" },
      accountIsDefault: true,
      vatCode: null,
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
      vatCode: null,
    });
  });

  it("reactivated, the default is back in the view as a default (AC-1.9)", async () => {
    const r = await submittedRequest([{ type: "travel_train" }]);
    fake.setAccountActive("5901", false);
    expect((await view(r.id)).body!["lines"][0].classification.account.state).toBe("deactivated");
    fake.setAccountActive("5901", true);
    expect((await view(r.id)).body!["lines"][0].classification).toMatchObject({ account: { number: "5901", state: "active" }, accountIsDefault: true });
  });

  it("a VAT code is no default: deactivating a code changes nothing of a line that holds none, in CHF or in EUR (20261118 SO-2)", async () => {
    const r = await submittedRequest([{ type: "travel_train" }, { type: "office_material", currency: "EUR" }]);
    fake.setVatCodeActive("IMP81", false);
    fake.setVatCodeActive("NOVAT", false);
    const [chf, eur] = (await view(r.id)).body!["lines"] as any[];
    expect([chf.classification.vatCode, eur.classification.vatCode]).toEqual([null, null]);
    expect([chf.vatAmountCents, eur.vatAmountCents]).toEqual([null, null]);
    expect((await approve(r.id)).status).toBe(200); // nor does it hold back an approval (AC-3.11)
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
        vatCodeIsDefault: false,
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

describe("the review view and the approval agree (AC-6.3)", () => {
  it("a deactivated default account: the view shows it deactivated, and approving is refused naming the line, its date and its type", async () => {
    const r = await submittedRequest([{ type: "travel_train" }, { type: "office_material" }]);
    fake.setAccountActive("5901", false);

    const shown = (await view(r.id)).body!["lines"] as any[];
    expect(shown[0].classification.account).toMatchObject({ number: "5901", state: "deactivated" });

    const refused = await approve(r.id);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: "classification_missing",
      lines: [{ lineId: r.lineIds[0], date: "2026-03-02", type: "travel_train", missing: ["account"] }],
    });
    expect((refused.body["lines"] as unknown[]).length).toBe(1);

    // Nothing moved: still submitted, no number consumed, no counter row, no copy written.
    expect((await db.refundRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("submitted");
    expect(await db.receiptCounter.count()).toBe(0);
    for (const id of r.lineIds) {
      const stored = await lineOf(id);
      expect([stored.receiptNumber, stored.accountNumber, stored.vatCodeCopy]).toEqual([null, null, null]);
    }
  });

  it("accounting names an account on the line: it approves, and the copy is what is booked, not the deactivated default", async () => {
    const r = await submittedRequest([{ type: "travel_train" }]);
    fake.setAccountActive("5901", false);
    expect((await approve(r.id)).status).toBe(409);

    expect((await put(r.id, r.lineIds[0]!, { accountNumber: "6101" })).status).toBe(200);
    expect((await approve(r.id)).status).toBe(200);
    expect(await lineOf(r.lineIds[0]!)).toMatchObject({
      accountNumber: "6101",
      ledgerAccountIsDefault: false,
      vatCodeCopy: null,
      vatCodeIsDefault: null,
      receiptNumber: "MC26/001",
    });
  });

  it("reactivated, the default is back and the approval books it as a default (AC-1.9)", async () => {
    const r = await submittedRequest([{ type: "travel_train" }]);
    fake.setAccountActive("5901", false);
    expect((await approve(r.id)).status).toBe(409);
    fake.setAccountActive("5901", true);
    expect((await approve(r.id)).status).toBe(200);
    expect(await lineOf(r.lineIds[0]!)).toMatchObject({ accountNumber: "5901", ledgerAccountIsDefault: true });
  });

  it("a line with no account is the only thing that refuses an approval: a missing VAT code never does, in CHF or EUR (AC-3.4, AC-3.11)", async () => {
    const r = await submittedRequest([{ type: "travel_train" }, { type: "office_material", currency: "EUR" }]);
    fake.setVatCodeActive("IMP81", false);
    fake.setVatCodeActive("NOVAT", false);
    fake.setAccountActive("6101", false);
    const refused = await approve(r.id);
    expect(refused.status).toBe(409);
    expect((refused.body["lines"] as any[]).map((l) => [l.lineId, l.missing])).toEqual([[r.lineIds[1], ["account"]]]);
  });

  it("a default deactivated AFTER the approval does not move the booked line (AC-5.3), and the line still shows it, deactivated", async () => {
    const r = await submittedRequest([{ type: "travel_train" }]);
    expect((await approve(r.id)).status).toBe(200);
    fake.setAccountActive("5901", false);

    const shown = (await view(r.id)).body!["lines"][0];
    expect(shown.classification).toMatchObject({ account: { number: "5901", state: "deactivated" }, vatCode: null });
    expect(await lineOf(r.lineIds[0]!)).toMatchObject({ accountNumber: "5901", vatCodeCopy: null });
  });

  it("a hand-chosen VAT code survives the approval and a later deactivation of the code (AC-3.5, AC-5.3)", async () => {
    const r = await submittedRequest([{ type: "travel_train" }]);
    expect((await put(r.id, r.lineIds[0]!, { vatCode: "IMP81" })).status).toBe(200);
    expect((await approve(r.id)).status).toBe(200);
    fake.setVatCodeActive("IMP81", false);
    const shown = (await view(r.id)).body!["lines"][0];
    expect(shown.classification.vatCode).toMatchObject({ code: "IMP81", state: "deactivated" });
    expect(await lineOf(r.lineIds[0]!)).toMatchObject({ accountNumber: "5901", vatCodeCopy: "IMP81", vatRateBasisPoints: 810, vatCodeIsDefault: false });
  });
});

describe("the release and the export agree (AC-7.2, AC-7.4)", () => {
  it("a legacy line whose type default is a deactivated account is numbered, left without an account, and blocks the export", async () => {
    const batch = await legacyBatch(["travel_train", "office_material"]);
    fake.setAccountActive("5901", false);

    const report = await release();
    expect(report.unclassified.map((l) => [l.lineId, l.missing, l.account])).toEqual([[batch.lineIds[0]!, ["account"], null]]);

    const [trainLine, officeLine] = await Promise.all(batch.lineIds.map(lineOf));
    expect(trainLine).toMatchObject({ accountNumber: null, accountName: null, vatCodeCopy: null, receiptNumber: "MC26/001" });
    expect(officeLine).toMatchObject({ accountNumber: "6101", vatCodeCopy: null, receiptNumber: "MC26/002" });

    // The export reads the same thing: stored-only, so the deactivated default is not consulted and the line blocks.
    const summary = await exportSummary(batch.batchId);
    expect(summary.body).toMatchObject({ exportable: false });
    expect(summary.body!["blockers"]["unclassifiedLines"]).toEqual([
      {
        lineId: batch.lineIds[0],
        requestId: batch.requestId,
        date: "2026-03-02",
        type: "travel_train",
        employee: "Matteo Codogno",
        receiptNumber: "MC26/001",
        missing: ["account"],
      },
    ]);
    expect((await exportFile(batch.batchId)).status).toBe(409);

    // Reactivating the default does NOT classify an approved line: only accounting can (AC-3.6).
    fake.setAccountActive("5901", true);
    expect((await exportSummary(batch.batchId)).body).toMatchObject({ exportable: false });
    expect((await lineOf(batch.lineIds[0]!)).accountNumber).toBeNull();

    // Accounting classifies it (`request:reclassify`): the export opens, with the stored account.
    expect((await put(batch.requestId, batch.lineIds[0]!, { accountNumber: "5901" })).status).toBe(200);
    expect((await exportSummary(batch.batchId)).body).toMatchObject({ exportable: true, rowCount: 2 });
    expect((await exportFile(batch.batchId)).status).toBe(200);
  });

  it("an approved line keeps a classification whose entries were deactivated afterwards, and the export includes it (AC-5.3)", async () => {
    const batch = await legacyBatch(["travel_train"]);
    await release();
    expect(await lineOf(batch.lineIds[0]!)).toMatchObject({ accountNumber: "5901", vatCodeCopy: null });

    fake.setAccountActive("5901", false);
    fake.resetCalls();
    const summary = await exportSummary(batch.batchId);
    expect(summary.body).toMatchObject({ exportable: true, rowCount: 1 });
    expect(summary.body!["blockers"]["unclassifiedLines"]).toEqual([]);
    expect(fake.calls).toHaveLength(0); // every copy is held: Accounting is not asked
  });

  it("a release with no VAT code in Accounting at all leaves nothing unclassified and the export open (AC-7.5: no VAT is needed)", async () => {
    const batch = await legacyBatch(["office_material"]);
    fake.removeVatCode("IMP81");
    fake.removeVatCode("NOVAT");
    const report = await release();
    expect(report.unclassified).toEqual([]);
    expect((await exportSummary(batch.batchId)).body).toMatchObject({ exportable: true, rowCount: 1 });
  });
});
