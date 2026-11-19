/**
 * AC-4.7 through the REAL lifecycle (QE pass T35, specs/20261118-refund-accounting-export).
 *
 * AC-4.7: "a numbered line's number never changes and is never reused, including when its classification
 * changes, when its batch is discarded, and when it is compiled into a later batch."
 *
 * The plan's row says "Reclassify, discard the batch, recompile -> number unchanged". The other tests prove the
 * pieces (the trigger refuses a raw UPDATE of the receipt columns; a hand-made discarded batch still shows its
 * numbers) but none walks the sequence through the routes, which is the only way to prove that no application path
 * renumbers: approve -> reclassify after approval -> compile -> discard -> compile again -> approve another request
 * of the same employee -> mark paid. At every step the numbers on the lines and the counter are read back from the
 * database, and the next approval must continue after the highest number ever issued, never reuse a number.
 *
 * Real Postgres, jwt/authz mocked (`test-support/testAuth.ts`), object storage and notify-api answered locally.
 * Each router is imported with its own query suffix (testAuth.ts, "no shared router specifier").
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
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

// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const realStorage = (await import("../lib/storage?real")) as typeof import("../lib/storage");
const storedObjectKeys = new Set<string>();
mock.module("../lib/storage", () => ({
  ...realStorage,
  putObject: async (objectKey: string) => {
    storedObjectKeys.add(objectKey);
  },
  headObject: async (objectKey: string) =>
    storedObjectKeys.has(objectKey) ? { sizeBytes: 1, contentType: "application/pdf" } : null,
  mintPresignedGet: async (objectKey: string) => `https://mock.example.com/${objectKey}?signed`,
}));

// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { decideRouter } = (await import("../review/decide.routes?qe-receipt-lifecycle")) as typeof import("../review/decide.routes");
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { batchesRouter } = (await import("../batches/batches.routes?qe-receipt-lifecycle")) as typeof import("../batches/batches.routes");
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { batchDecideRouter } = (await import("../batches/decide.routes?qe-receipt-lifecycle")) as typeof import("../batches/decide.routes");
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { classificationRouter } = (await import("./classification.routes?qe-receipt-lifecycle")) as typeof import("./classification.routes");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { notifyTransport } = await import("../lib/notifyPost");
const { createStandardFakeAccounting, useFakeAccounting, restoreAccounting } = await import("../test-support/fakeAccounting");

const realTokens = notifyTransport.tokens;
notifyTransport.tokens = { async getToken() { return "stub-service-jwt"; }, invalidate() {} };
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (typeof url === "string" && url.includes("/system/emails")) return new Response(JSON.stringify({ deliveryId: "d1", status: "sent" }), { status: 200 });
  if (typeof url === "string" && url.includes("/system/")) return new Response(JSON.stringify({ id: "n1" }), { status: 201 });
  return originalFetch(url, init);
}) as unknown as typeof fetch;

/** Accounting with everything the walk needs: review (compile, discard, mark-paid), approve, and reclassify. */
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
const OWNER = { id: "u-matteo", name: "Matteo Codogno", email: "matteo.codogno@welld.ch" };

let office: { id: string };
let train: { id: string };
let imp81: { id: string };

beforeEach(async () => {
  await truncateRefundTables();
  __resetAuthzCacheForTests();
  harness.setResolve(async () => ACCOUNTING);
  office = await db.ledgerAccount.create({ data: { entity: "welld_ch", number: "6101", name: "Ufficio", ...by } });
  train = await db.ledgerAccount.create({ data: { entity: "welld_ch", number: "5901", name: "Treno", ...by } });
  imp81 = await db.vatCode.create({ data: { entity: "welld_ch", code: "IMP81", label: "IVA 8.1%", rateBasisPoints: 810, ...by } });
  await db.expenseTypeDefault.create({ data: { entity: "welld_ch", type: "office_material", ledgerAccountId: office.id, vatCodeId: imp81.id, ...by } });
  useFakeAccounting(createStandardFakeAccounting()); // T19: the reclassification below reads Accounting, by natural key
});
afterAll(async () => {
  restoreAccounting();
  await truncateRefundTables();
  notifyTransport.tokens = realTokens;
  globalThis.fetch = originalFetch;
});

async function call(router: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }, path: string, init: RequestInit = {}) {
  const token = await harness.signToken({ sub: "acct-1", email: "acct-1@welld.ch" });
  return router.request(path, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
}

/** A submitted request of the owner with one line per spec (CH office material unless it says WellD Italia). */
async function submittedRequest(lines: { date: string; entity?: "welld_ch" | "welld_it" }[]) {
  const request = await db.refundRequest.create({
    data: { ownerUserId: OWNER.id, ownerEmail: OWNER.email, ownerName: OWNER.name, status: "submitted", submittedAt: new Date() },
  });
  const lineIds: string[] = [];
  for (const spec of lines) {
    const line = await db.refundLine.create({
      data: {
        requestId: request.id,
        date: new Date(spec.date),
        type: "office_material",
        motivo: "Cancelleria",
        entity: spec.entity ?? "welld_ch",
        currency: "CHF",
        requestedAmountCents: 2080,
      },
    });
    lineIds.push(line.id);
  }
  return { requestId: request.id, lineIds };
}

const approve = (requestId: string) => call(decideRouter, `/review/requests/${requestId}/approve`, { method: "POST" });
const compile = () => call(batchesRouter, "/batches", { method: "POST", body: JSON.stringify({}) });
const discard = (batchId: string) => call(batchDecideRouter, `/batches/${batchId}/discard`, { method: "POST" });
const markPaid = (batchId: string) => call(batchDecideRouter, `/batches/${batchId}/mark-paid`, { method: "POST" });
const reclassify = (requestId: string, lineId: string, accountNumber: string) =>
  call(classificationRouter, `/review/requests/${requestId}/lines/${lineId}/classification`, { method: "PUT", body: JSON.stringify({ accountNumber }) });

/** The numbers of a set of lines, as stored. */
async function numbersOf(lineIds: string[]) {
  const rows = await db.refundLine.findMany({ where: { id: { in: lineIds } } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return lineIds.map((id) => {
    const r = byId.get(id)!;
    return `${r.receiptNumber}|${r.receiptOwnerUserId}|${r.receiptYear}|${r.receiptSeq}`;
  });
}
const counter = async () => (await db.receiptCounter.findUnique({ where: { ownerUserId_year: { ownerUserId: OWNER.id, year: 2026 } } }))?.lastSeq ?? null;

describe("AC-4.7: a number issued stays, through the whole lifecycle", () => {
  it("approve -> reclassify -> compile -> discard -> compile again -> next approval -> mark paid: no number changes, none is reused", async () => {
    // 1. Approve: two CH lines and one WellD Italia line (numbered too, AC-4.1), in date order.
    const first = await submittedRequest([{ date: "2026-03-10" }, { date: "2026-03-02" }, { date: "2026-03-05", entity: "welld_it" }]);
    expect((await approve(first.requestId)).status).toBe(200);
    const [l10, l02, lIt] = first.lineIds as [string, string, string];
    const issued = await numbersOf([l02, lIt, l10]);
    expect(issued.map((n) => n.split("|")[0])).toEqual(["MC26/001", "MC26/002", "MC26/003"]);
    expect(await counter()).toBe(3);

    // 2. The classification changes after approval (AC-3.6): the number does not.
    const re = await reclassify(first.requestId, l02, "5901");
    expect(re.status).toBe(200);
    expect((await db.refundLine.findUniqueOrThrow({ where: { id: l02 } })).accountNumber).toBe("5901");
    expect(await numbersOf([l02, lIt, l10])).toEqual(issued);

    // 3. Compiled into a batch.
    const compiled = await compile();
    expect(compiled.status).toBe(201);
    const batchId = ((await compiled.json()) as { id: string }).id;
    expect(await numbersOf([l02, lIt, l10])).toEqual(issued);

    // 4. The batch is discarded: the request is free again, its lines keep their numbers, the counter does not move back.
    expect((await discard(batchId)).status).toBe(200);
    expect((await db.refundRequest.findUniqueOrThrow({ where: { id: first.requestId } })).batchId).toBeNull();
    expect(await numbersOf([l02, lIt, l10])).toEqual(issued);
    expect(await counter()).toBe(3);

    // 5. Compiled into a LATER batch: still the same numbers.
    const again = await compile();
    expect(again.status).toBe(201);
    const laterBatchId = ((await again.json()) as { id: string }).id;
    expect(laterBatchId).not.toBe(batchId);
    expect((await db.refundRequest.findUniqueOrThrow({ where: { id: first.requestId } })).batchId).toBe(laterBatchId);
    expect(await numbersOf([l02, lIt, l10])).toEqual(issued);

    // 6. The next approval of the same employee continues after the highest number ever issued: 001..003 are not reused,
    //    although the first batch that carried them was discarded.
    const second = await submittedRequest([{ date: "2026-03-20" }]);
    expect((await approve(second.requestId)).status).toBe(200);
    expect((await numbersOf(second.lineIds))[0]!.split("|")[0]).toBe("MC26/004");
    expect(await counter()).toBe(4);

    // 7. Paid: the numbers are what they were, and the guard of the paid request does not renumber either.
    expect((await markPaid(laterBatchId)).status).toBe(200);
    expect(await numbersOf([l02, lIt, l10])).toEqual(issued);

    // 8. Every number ever issued to this employee in 2026 is distinct and exactly 001..004.
    const all = await db.refundLine.findMany({ where: { receiptOwnerUserId: OWNER.id, receiptYear: 2026 }, orderBy: { receiptSeq: "asc" } });
    expect(all.map((l) => l.receiptNumber)).toEqual(["MC26/001", "MC26/002", "MC26/003", "MC26/004"]);
  });

  it("the discarded batch's old items still list the same numbers when its requests are in a later batch", async () => {
    const first = await submittedRequest([{ date: "2026-03-02" }]);
    expect((await approve(first.requestId)).status).toBe(200);
    const compiled = await compile();
    const batchId = ((await compiled.json()) as { id: string }).id;
    expect((await discard(batchId)).status).toBe(200);
    const later = ((await (await compile()).json()) as { id: string }).id;

    // Both batches' detail views (the discarded one through its items, AC-6.3 of the monthly-processing spec) show MC26/001.
    for (const id of [batchId, later]) {
      const res = await call(batchesRouter, `/batches/${id}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { employees: { requests: { receiptNumbers: string[] }[] }[] };
      expect(body.employees.flatMap((e) => e.requests.flatMap((r) => r.receiptNumbers))).toEqual(["MC26/001"]);
    }
  });
});
