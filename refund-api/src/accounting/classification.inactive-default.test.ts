/**
 * "A deactivated default counts as missing", in every place a line is resolved
 * (T19, specs/20261118-refund-accounting-export; AC-1.3, AC-1.6, AC-2.7, AC-3.4,
 * AC-7.2; plan G3 and § Test strategy "Extra tests", last row; ADR
 * 20261118-accounting-classification-is-live-until-approval-then-frozen-...).
 *
 * `resolveClassification` is ONE function behind four places that must never
 * disagree: the review view, the approval freeze, the release backfill and the
 * export blockers (T4's header). The unit vectors of `classification.test.ts` prove
 * the function. This file proves the PLACES: a type default that points at a
 * deactivated account gives `account: null` in the view, refuses the approval,
 * is left unclassified by the release, and blocks the export, while a value
 * already STORED on a line (an override or a frozen classification) is kept, with
 * `active: false`, and still exports. Real Postgres, jwt/authz mocked, no network.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { ResolveResponse } from "../authz/resolveClient";
import { truncateRefundTables } from "../test-support/dbCleanup";
import { setupTestAuth } from "../test-support/testAuth";
import { resolveClassification, type AccountRef, type ClassifiableLine, type VatCodeRef } from "./classification";

process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = "http://localhost:3001/auth/jwks";
process.env["AUTH_ISSUER"] = "http://localhost:3001";
process.env["AUTH_BASE_URL"] = "http://localhost:3001";
process.env["AUTH_AUDIENCE"] = "operai-suite";
process.env["NODE_ENV"] = "test";
process.env["NOTIFY_INTERNAL_URL"] = "http://localhost:8081";
process.env["SERVICE_CLIENT_ID"] = "refund-api";
process.env["SERVICE_CLIENT_SECRET"] = "test-service-client-secret-at-least-32-characters";

const harness = setupTestAuth();
await harness.init();

// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { decideRouter } = (await import("../review/decide.routes?inactive-default")) as typeof import("../review/decide.routes");
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { classificationRouter } = (await import("./classification.routes?inactive-default")) as typeof import("./classification.routes");
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { createExportRouter } = (await import("./export.routes?inactive-default")) as typeof import("./export.routes");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { createFxService } = await import("../fx/fx.service");
const { setLedgerAccountActive, setVatCodeActive } = await import("./catalog.repo");
const { setForeignCurrencyVatCode } = await import("./defaults.repo");
const { notifyTransport } = await import("../lib/notifyPost");
const { parseSeed, runAccountingRelease } = await import("../../scripts/accounting-release");

const realTokens = notifyTransport.tokens;
notifyTransport.tokens = { async getToken() { return "stub-service-jwt"; }, invalidate() {} };
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (typeof url === "string" && url.includes("/system/")) return new Response(JSON.stringify({ id: "n1" }), { status: 200 });
  return originalFetch(url, init);
}) as unknown as typeof fetch;

const exportRouter = createExportRouter({ fx: createFxService({ mode: "off" }) });

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
const ADMIN = { userId: "admin", email: "admin@welld.ch" };

let train: { id: string };
let office: { id: string };
let imp81: { id: string };
let novat: { id: string };

beforeEach(async () => {
  await truncateRefundTables();
  __resetAuthzCacheForTests();
  harness.setResolve(async () => ACCOUNTING);
  train = await db.ledgerAccount.create({ data: { entity: "welld_ch", number: "5901", name: "Spese viaggi in treno", ...by } });
  office = await db.ledgerAccount.create({ data: { entity: "welld_ch", number: "6101", name: "Spese materiale ufficio", ...by } });
  imp81 = await db.vatCode.create({ data: { entity: "welld_ch", code: "IMP81", label: "IVA 8.1%", rateBasisPoints: 810, ...by } });
  novat = await db.vatCode.create({ data: { entity: "welld_ch", code: "NOVAT", label: "Senza IVA", rateBasisPoints: 0, ...by } });
  await db.expenseTypeDefault.create({ data: { entity: "welld_ch", type: "travel_train", ledgerAccountId: train.id, vatCodeId: imp81.id, ...by } });
  await db.expenseTypeDefault.create({ data: { entity: "welld_ch", type: "office_material", ledgerAccountId: office.id, vatCodeId: imp81.id, ...by } });
  await setForeignCurrencyVatCode(novat.id, ADMIN);
});
afterAll(async () => {
  await truncateRefundTables();
  notifyTransport.tokens = realTokens;
  globalThis.fetch = originalFetch;
});

const deactivate = (kind: "account" | "vat", id: string) =>
  kind === "account" ? setLedgerAccountActive(id, false, ADMIN) : setVatCodeActive(id, false, ADMIN);
const reactivate = (kind: "account" | "vat", id: string) =>
  kind === "account" ? setLedgerAccountActive(id, true, ADMIN) : setVatCodeActive(id, true, ADMIN);

// ─── Calls ───────────────────────────────────────────────────────────────────

async function call(router: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }, path: string, init: RequestInit = {}) {
  const token = await harness.signToken({ sub: "acct-1", email: "acct-1@welld.ch" });
  const res = await router.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  return { status: res.status, body: (isJson && text ? JSON.parse(text) : null) as Record<string, any> | null };
}
const view = (requestId: string) => call(classificationRouter, `/review/requests/${requestId}/accounting`);
const approve = (requestId: string) => call(decideRouter, `/review/requests/${requestId}/approve`, { method: "POST" });
const put = (requestId: string, lineId: string, body: object) =>
  call(classificationRouter, `/review/requests/${requestId}/lines/${lineId}/classification`, { method: "PUT", body: JSON.stringify(body) });
const exportSummary = (batchId: string) => call(exportRouter, `/batches/${batchId}/accounting-export`);
const exportCsv = (batchId: string) => call(exportRouter, `/batches/${batchId}/accounting-export/csv`);

// ─── Fixtures ────────────────────────────────────────────────────────────────

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

const lineOf = (id: string) => db.refundLine.findUniqueOrThrow({ where: { id } });
const EMPTY_SEED = parseSeed({ ledgerAccounts: [], vatCodes: [], typeDefaults: {}, foreignCurrencyVatCode: null });

// ═════════════════════════════════════════════════════════════════════════════

describe("resolveClassification: the vector (G3)", () => {
  const ref = (active: boolean): AccountRef => ({ id: "a1", number: "5901", name: "Treno", active });
  const vat: VatCodeRef = { id: "v1", code: "IMP81", label: "IVA 8.1%", rateBasisPoints: 810, active: true };
  const line = (over: Partial<ClassifiableLine> = {}): ClassifiableLine => ({
    entity: "welld_ch",
    currency: "CHF",
    type: "travel_train",
    rejected: false,
    ledgerAccount: null,
    ledgerAccountIsDefault: null,
    vatCode: null,
    vatCodeIsDefault: null,
    ...over,
  });

  it("a type default pointing at an inactive account: account null, missing account, the VAT half untouched", () => {
    const result = resolveClassification(line(), { travel_train: { account: ref(false), vatCode: vat } }, null);
    expect(result).toMatchObject({ account: null, accountIsDefault: false, vatCode: vat, vatCodeIsDefault: true, missing: ["account"] });
  });

  it("a stored override on an inactive account is kept, with active:false, and is not missing", () => {
    const result = resolveClassification(
      line({ ledgerAccount: ref(false), ledgerAccountIsDefault: false }),
      { travel_train: { account: ref(true), vatCode: vat } },
      null,
    );
    expect(result?.account).toEqual(ref(false));
    expect(result?.account?.active).toBe(false);
    expect(result?.missing).toEqual([]);
  });

  it("reactivated, the same default is back", () => {
    expect(resolveClassification(line(), { travel_train: { account: ref(true), vatCode: vat } }, null)).toMatchObject({
      account: ref(true),
      accountIsDefault: true,
      missing: [],
    });
  });
});

describe("the review view and the approval agree (AC-3.4)", () => {
  it("a deactivated default account: the view shows account null, and approving is refused naming the line, its date and its type", async () => {
    const r = await submittedRequest([{ type: "travel_train" }, { type: "office_material" }]);
    await deactivate("account", train.id);

    const shown = await view(r.id);
    const [trainLine, officeLine] = shown.body!["lines"] as any[];
    expect(trainLine.classification).toMatchObject({
      account: null,
      accountIsDefault: false,
      vatCode: { code: "IMP81" },
      vatCodeIsDefault: true,
    });
    expect(officeLine.classification.account).toMatchObject({ number: "6101", active: true });

    const refused = await approve(r.id);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: "classification_missing",
      lines: [{ lineId: r.lineIds[0], date: "2026-03-02", type: "travel_train", missing: ["account"] }],
    });
    expect((refused.body!["lines"] as unknown[]).length).toBe(1);

    // Nothing moved: still submitted, no number consumed, no counter row, no classification written.
    expect((await db.refundRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("submitted");
    expect(await db.receiptCounter.count()).toBe(0);
    for (const id of r.lineIds) {
      const stored = await lineOf(id);
      expect([stored.receiptNumber, stored.ledgerAccountId, stored.vatCodeId]).toEqual([null, null, null]);
    }
  });

  it("accounting names an account on the line: it approves, and the override is what is frozen, not the deactivated default", async () => {
    const r = await submittedRequest([{ type: "travel_train" }]);
    await deactivate("account", train.id);
    expect((await approve(r.id)).status).toBe(409);

    expect((await put(r.id, r.lineIds[0]!, { ledgerAccountId: office.id })).status).toBe(200);
    expect((await approve(r.id)).status).toBe(200);
    const line = await lineOf(r.lineIds[0]!);
    expect(line).toMatchObject({ ledgerAccountId: office.id, ledgerAccountIsDefault: false, vatCodeId: imp81.id, vatCodeIsDefault: true, receiptNumber: "MC26/001" });
  });

  it("the deactivated account cannot be chosen again (AC-1.3): the PUT is 422, and nothing is stored", async () => {
    const r = await submittedRequest([{ type: "travel_train" }]);
    await deactivate("account", train.id);
    const refused = await put(r.id, r.lineIds[0]!, { ledgerAccountId: train.id });
    expect([refused.status, refused.body!["code"]]).toEqual([422, "ledger_account_inactive"]);
    expect((await lineOf(r.lineIds[0]!)).ledgerAccountId).toBeNull();
  });

  it("reactivated, the default is back in the view and approving freezes it as a default (AC-1.9)", async () => {
    const r = await submittedRequest([{ type: "travel_train" }]);
    await deactivate("account", train.id);
    expect((await approve(r.id)).status).toBe(409);
    await reactivate("account", train.id);

    const shown = (await view(r.id)).body!["lines"][0];
    expect(shown.classification).toMatchObject({ account: { number: "5901", active: true }, accountIsDefault: true });
    expect((await approve(r.id)).status).toBe(200);
    expect(await lineOf(r.lineIds[0]!)).toMatchObject({ ledgerAccountId: train.id, ledgerAccountIsDefault: true });
  });

  it("the same holds for a deactivated default VAT code, and for a deactivated foreign-currency designation (AC-2.7)", async () => {
    const r = await submittedRequest([{ type: "travel_train" }, { type: "office_material", currency: "EUR" }]);
    await deactivate("vat", imp81.id); // the type default of the CHF line
    await deactivate("vat", novat.id); // the designation used by the EUR line
    const refused = await approve(r.id);
    expect(refused.status).toBe(409);
    expect((refused.body!["lines"] as any[]).map((l) => [l.lineId, l.missing])).toEqual([
      [r.lineIds[0], ["vatCode"]],
      [r.lineIds[1], ["vatCode"]],
    ]);
  });

  it("a default deactivated AFTER the approval does not move the frozen line (AC-2.3, AC-3.5), and the line still shows it, inactive", async () => {
    const r = await submittedRequest([{ type: "travel_train" }]);
    expect((await approve(r.id)).status).toBe(200);
    await deactivate("account", train.id);
    await deactivate("vat", imp81.id);

    const shown = (await view(r.id)).body!["lines"][0];
    expect(shown.classification).toMatchObject({
      account: { number: "5901", active: false },
      vatCode: { code: "IMP81", active: false },
    });
    expect(await lineOf(r.lineIds[0]!)).toMatchObject({ ledgerAccountId: train.id, vatCodeId: imp81.id });
  });
});

describe("the release and the export agree (AC-7.2)", () => {
  it("a legacy line whose type default is a deactivated account is numbered, left without an account, and blocks the export", async () => {
    const batch = await legacyBatch(["travel_train", "office_material"]);
    await deactivate("account", train.id);

    const report = await runAccountingRelease({ seed: EMPTY_SEED, now: () => new Date("2026-11-20T08:00:00Z") });
    expect(report.unclassified.map((l) => [l.lineId, l.missing, l.account, l.vatCode])).toEqual([
      [batch.lineIds[0]!, ["account"], null, "IMP81"],
    ]);

    const [trainLine, officeLine] = await Promise.all(batch.lineIds.map(lineOf));
    expect(trainLine).toMatchObject({ ledgerAccountId: null, vatCodeId: imp81.id, receiptNumber: "MC26/001" });
    expect(officeLine).toMatchObject({ ledgerAccountId: office.id, vatCodeId: imp81.id, receiptNumber: "MC26/002" });

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
    expect((await exportCsv(batch.batchId)).status).toBe(409);

    // Reactivating the default does NOT classify an approved line: only accounting can (AC-3.6).
    await reactivate("account", train.id);
    expect((await exportSummary(batch.batchId)).body).toMatchObject({ exportable: false });
    expect((await lineOf(batch.lineIds[0]!)).ledgerAccountId).toBeNull();

    // Accounting classifies it (`request:reclassify`): the export opens, with the stored account.
    expect((await put(batch.requestId, batch.lineIds[0]!, { ledgerAccountId: train.id })).status).toBe(200);
    expect((await exportSummary(batch.batchId)).body).toMatchObject({ exportable: true, rowCount: 2 });
    const csv = await call(exportRouter, `/batches/${batch.batchId}/accounting-export/csv`);
    expect(csv.status).toBe(200);
  });

  it("an approved line keeps a classification whose entries were deactivated afterwards, and the export includes it (AC-1.3, AC-1.6)", async () => {
    const batch = await legacyBatch(["travel_train"]);
    await runAccountingRelease({ seed: EMPTY_SEED, now: () => new Date("2026-11-20T08:00:00Z") });
    expect(await lineOf(batch.lineIds[0]!)).toMatchObject({ ledgerAccountId: train.id, vatCodeId: imp81.id });

    await deactivate("account", train.id);
    await deactivate("vat", imp81.id);
    const summary = await exportSummary(batch.batchId);
    expect(summary.body).toMatchObject({ exportable: true, rowCount: 1 });
    expect(summary.body!["blockers"]["unclassifiedLines"]).toEqual([]);
  });
});
