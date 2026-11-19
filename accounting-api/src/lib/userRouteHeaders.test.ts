/**
 * `Cache-Control: no-store` and `X-Content-Type-Options: nosniff` on every answer of the user routes `/v1/*`, whatever its status
 * (security-review F-07, specs/20261119-accounting; AC-6.1, D2 "read live, keep nothing"). Through the ASSEMBLED app.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { fakeResolve, PERSONAS } from "../test-support/fakeResolve";
import { truncateAccountingTables } from "../test-support/dbCleanup";
import { setupTestAuth } from "../test-support/testAuth";

const harness = setupTestAuth();
await harness.init();

const { app } = await import("../index");
const { __resetAuthzCacheForTests } = await import("../authz/authz.middleware");

type Persona = (typeof PERSONAS)[keyof typeof PERSONAS];

async function call(method: string, path: string, opts: { persona?: Persona; token?: false; body?: string; headers?: Record<string, string> } = {}) {
  __resetAuthzCacheForTests();
  const persona = opts.persona ?? PERSONAS.accountingCh;
  harness.setResolve(fakeResolve(persona));
  const headers: Record<string, string> = { "Content-Type": "application/json", ...opts.headers };
  if (opts.token !== false) headers["Authorization"] = `Bearer ${await harness.signToken({ sub: persona.sub, email: `${persona.sub}@welld.ch` })}`;
  return app.request(path, { method, headers, ...(opts.body === undefined ? {} : { body: opts.body }) });
}

const expectSafeHeaders = (res: Response) => {
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
};

beforeAll(truncateAccountingTables);
beforeEach(async () => {
  await truncateAccountingTables();
  __resetAuthzCacheForTests();
});
afterAll(truncateAccountingTables);

describe("every answer of a user route carries no-store and nosniff", () => {
  it("200: the lists, the rates, `/v1/me`", async () => {
    for (const path of ["/v1/entities/welld_ch/ledger-accounts", "/v1/entities/welld_ch/vat-codes", "/v1/entities/welld_ch/exchange-rates?month=2026-10", "/v1/me"]) {
      const res = await call("GET", path);
      expect([path, res.status]).toEqual([path, 200]);
      expectSafeHeaders(res);
    }
  });

  it("201 and 409 and 422 of a create", async () => {
    const path = "/v1/entities/welld_ch/ledger-accounts";
    const created = await call("POST", path, { body: JSON.stringify({ number: "5905", name: "Treno" }) });
    expect(created.status).toBe(201);
    expectSafeHeaders(created);
    const duplicate = await call("POST", path, { body: JSON.stringify({ number: "5905", name: "Treno" }) });
    expect(duplicate.status).toBe(409);
    expectSafeHeaders(duplicate);
    const refused = await call("POST", path, { body: JSON.stringify({ number: "59a", name: "x" }) });
    expect(refused.status).toBe(422);
    expectSafeHeaders(refused);
  });

  it("400 (malformed body), 401, 403, 404 (entity, entry, a method with no route) and 413", async () => {
    const list = "/v1/entities/welld_ch/ledger-accounts";
    const cases: [number, Response][] = [
      [400, await call("POST", list, { body: "{not json" })],
      [401, await call("GET", list, { token: false })],
      [403, await call("GET", list, { persona: PERSONAS.outsider })],
      [404, await call("GET", "/v1/entities/welld_xx/ledger-accounts")],
      [404, await call("POST", `${list}/5905/deactivate`)],
      [404, await call("DELETE", `${list}/5905`)],
      [404, await call("GET", "/v1/nothing-here", { token: false })],
      [413, await call("POST", list, { body: JSON.stringify({ number: "5905", name: "x".repeat(8000) }) })],
    ];
    for (const [status, res] of cases) {
      expect(res.status).toBe(status);
      expectSafeHeaders(res);
    }
  });

  it("a 500 of the global error handler too", async () => {
    // A well-formed request whose database read fails: the answer is the generic 500 and still carries the headers.
    const { db } = await import("../lib/db");
    const original = db.ledgerAccount.findMany;
    (db.ledgerAccount as { findMany: unknown }).findMany = () => Promise.reject(new Error("simulated failure"));
    try {
      const res = await call("GET", "/v1/entities/welld_ch/ledger-accounts");
      expect(res.status).toBe(500);
      expectSafeHeaders(res);
    } finally {
      (db.ledgerAccount as { findMany: unknown }).findMany = original;
    }
  });
});

describe("what it does not touch", () => {
  it("a CORS preflight still answers 204 with its CORS headers", async () => {
    const preflight = await call("OPTIONS", "/v1/entities/welld_ch/ledger-accounts", {
      token: false,
      headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "POST" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });
});
