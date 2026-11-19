/**
 * F-07 (security review of specs/20261119-accounting, A05): every answer of the classification, options and defaults routes,
 * refusals and failures included, is `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`. They carry an
 * employee's name and email, CHF and VAT figures and Refund's accounting defaults, and AC-4.8 / D2 ("read live, keep nothing")
 * is only as good as the layers between the caller and the code; the export routes (S-06) already did this.
 *
 * Real Postgres for the one request the view reads, jwt/authz mocked, a FAKE `AccountingPort` (no network).
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

// A query suffix gives each router a module instance of this file alone (testAuth.ts, "no shared router specifier").
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { classificationRouter } = (await import("./classification.routes?no-store")) as typeof import("./classification.routes");
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { defaultsRouter } = (await import("./defaults.routes?no-store")) as typeof import("./defaults.routes");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { createFakeAccounting, useFakeAccounting, restoreAccounting } = await import("../test-support/fakeAccounting");

const REVIEWER: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [
    { resource: "refund", action: "access", conditions: null },
    { resource: "request", action: "review", conditions: null },
    { resource: "request", action: "set-approved-total", conditions: null },
    { resource: "request", action: "reclassify", conditions: null },
    { resource: "settings", action: "read", conditions: null },
    { resource: "settings", action: "manage", conditions: null },
  ],
  entity: null,
  jobTitle: null,
};
const NO_GRANTS: ResolveResponse = { sub: "", epoch: 1, permissions: [], entity: null, jobTitle: null };

const fake = createFakeAccounting();
beforeEach(async () => {
  await truncateRefundTables({ released: false });
  __resetAuthzCacheForTests();
  fake.failWith(null).failReferenceDataWith(null).failRatesWith(null).setDelayMs(0).onRead(null).resetCalls();
  fake.setAccount("5901", "Treno").setVatCode("IMP81", "IVA 8.1%", 810);
  useFakeAccounting(fake);
});
afterAll(async () => {
  restoreAccounting();
  await truncateRefundTables({ released: false });
});

type Router = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
async function call(router: Router, method: string, path: string, opts: { body?: unknown; as?: ResolveResponse; token?: boolean } = {}) {
  __resetAuthzCacheForTests();
  harness.setResolve(async () => opts.as ?? REVIEWER);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token !== false) headers["Authorization"] = `Bearer ${await harness.signToken({ sub: "rev-1", email: "rev@welld.ch" })}`;
  const res = await router.request(path, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
  await res.text();
  return res;
}
const expectNoStore = (res: Response, status: number) => {
  expect(res.status).toBe(status);
  expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
};

describe("GET /accounting/options", () => {
  it("200, 403 (no grant), 401 (no token) and 503 (Accounting unreadable)", async () => {
    expectNoStore(await call(classificationRouter, "GET", "/accounting/options"), 200);
    expectNoStore(await call(classificationRouter, "GET", "/accounting/options", { as: NO_GRANTS }), 403);
    expectNoStore(await call(classificationRouter, "GET", "/accounting/options", { token: false }), 401);
    fake.failWith("network");
    expectNoStore(await call(classificationRouter, "GET", "/accounting/options"), 503);
  });
});

describe("GET /review/requests/:id/accounting and PUT .../classification", () => {
  it("the view: 200 for a request, 404 for an unknown one, 404 (it does not say it exists) and 401 for a caller without the grant or token", async () => {
    const request = await db.refundRequest.create({
      data: { ownerUserId: "emp-1", ownerEmail: "emp-1@welld.ch", ownerName: "Matteo Codogno", status: "submitted" },
    });
    await db.refundLine.create({
      data: { requestId: request.id, date: new Date("2026-03-02"), type: "travel_train", motivo: "m", entity: "welld_ch", currency: "CHF", requestedAmountCents: 2080 },
    });
    expectNoStore(await call(classificationRouter, "GET", `/review/requests/${request.id}/accounting`), 200);
    expectNoStore(await call(classificationRouter, "GET", "/review/requests/nope/accounting"), 404);
    expectNoStore(await call(classificationRouter, "GET", `/review/requests/${request.id}/accounting`, { as: NO_GRANTS }), 404);
    expectNoStore(await call(classificationRouter, "GET", `/review/requests/${request.id}/accounting`, { token: false }), 401);
  });

  it("the classify write: 422 (bad body), 404 (unknown line), 403 and 401, and 413 (body too large)", async () => {
    const path = "/review/requests/r1/lines/l1/classification";
    expectNoStore(await call(classificationRouter, "PUT", path, { body: { accountNumber: 5 } }), 422);
    expectNoStore(await call(classificationRouter, "PUT", path, { body: { accountNumber: "5901", vatCode: "IMP81" } }), 404);
    expectNoStore(await call(classificationRouter, "PUT", path, { body: { accountNumber: "5901" }, as: NO_GRANTS }), 403);
    expectNoStore(await call(classificationRouter, "PUT", path, { body: {}, token: false }), 401);
    expectNoStore(await call(classificationRouter, "PUT", path, { body: { accountNumber: "x".repeat(8000) } }), 413);
  });
});

describe("the defaults routes", () => {
  it("GET: 200, 403, 401; and with Accounting unreadable it is still 200 with the header", async () => {
    expectNoStore(await call(defaultsRouter, "GET", "/accounting/expense-type-defaults"), 200);
    expectNoStore(await call(defaultsRouter, "GET", "/accounting/expense-type-defaults", { as: NO_GRANTS }), 403);
    expectNoStore(await call(defaultsRouter, "GET", "/accounting/expense-type-defaults", { token: false }), 401);
    fake.failWith("timeout");
    expectNoStore(await call(defaultsRouter, "GET", "/accounting/expense-type-defaults"), 200);
  });

  it("PUT type: 200, 422 (bad key, and a body that still carries a VAT code), 403, 401, 413 and 503", async () => {
    const type = "/accounting/expense-type-defaults/travel_train";
    expectNoStore(await call(defaultsRouter, "PUT", type, { body: { accountNumber: "5901" } }), 200);
    expectNoStore(await call(defaultsRouter, "PUT", type, { body: { accountNumber: 5 } }), 422);
    expectNoStore(await call(defaultsRouter, "PUT", type, { body: { accountNumber: "5901", vatCode: "IMP81" } }), 422);
    expectNoStore(await call(defaultsRouter, "PUT", type, { body: { accountNumber: "5901" }, as: NO_GRANTS }), 403);
    expectNoStore(await call(defaultsRouter, "PUT", type, { body: { accountNumber: null }, token: false }), 401);
    expectNoStore(await call(defaultsRouter, "PUT", type, { body: { accountNumber: "x".repeat(8000) } }), 413);
    fake.failWith("network");
    expectNoStore(await call(defaultsRouter, "PUT", type, { body: { accountNumber: "5901" } }), 503);
  });

  it("the designation route of 20261118 is gone: a plain 404 for everyone, not behind authentication", async () => {
    const designation = "/accounting/foreign-currency-vat-code";
    for (const token of [true, false]) {
      expect((await call(defaultsRouter, "PUT", designation, { body: { vatCode: "IMP81" }, token })).status).toBe(404);
    }
  });
});
