/**
 * Integration tests for the catalog management endpoints (T6,
 * specs/20261118-refund-accounting-export, plan § API contracts).
 *
 * Real Postgres, jwt/authz mocked through test-support/testAuth.ts (this file
 * owns `catalog.routes` as its router specifier).
 *
 * AC coverage: 1.1 add, 1.2 duplicate account (also deactivated, also racing),
 * 1.4 VAT code and rate in basis points, 1.5 no PUT/PATCH, 1.7 capability
 * gates (incl. reactivate), 1.8 history before -> after, 1.9 / 1.10
 * reactivation, 1.11 already active writes nothing. The deactivated-entry
 * rules for options and classification (AC-1.3, AC-1.6) belong to T7/T13/T14.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { ResolveResponse } from "../authz/resolveClient";
import { setupTestAuth } from "../test-support/testAuth";
import { truncateRefundTables } from "../test-support/dbCleanup";

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

const { catalogRouter } = await import("./catalog.routes");
const { percentToBasisPoints, basisPointsToPercent } = await import("./catalog.repo");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");

const grants = (...actions: ("read" | "manage")[]): ResolveResponse => ({
  sub: "",
  epoch: 1,
  permissions: actions.map((action) => ({ resource: "settings", action, conditions: null })),
  entity: null,
  jobTitle: null,
});
const NONE = grants();
const READ = grants("read");
const MANAGE = grants("manage");
const BOTH = grants("read", "manage");

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; raw?: string; as?: ResolveResponse; sub?: string; email?: string; token?: boolean } = {},
) {
  __resetAuthzCacheForTests(); // the middleware caches per (sub, epoch): every call resolves afresh
  harness.setResolve(async () => opts.as ?? BOTH);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token !== false) {
    headers["Authorization"] = `Bearer ${await harness.signToken({ sub: opts.sub ?? "admin-1", email: opts.email ?? "admin@welld.ch" })}`;
  }
  const res = await catalogRouter.request(path, {
    method,
    headers,
    ...(opts.raw !== undefined ? { body: opts.raw } : opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let body: Record<string, any> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, any>) : {};
  } catch {
    body = { text }; // the router's own 404 for a method with no route is plain text
  }
  return { status: res.status, body };
}

const addAccount = (number = "5905", name = "Spese rimborsi chilometrici") =>
  call("POST", "/accounting/ledger-accounts", { body: { number, name } });
const addVat = (code = "IMP81", ratePercent = "8.1", label = "IVA 8.1%") =>
  call("POST", "/accounting/vat-codes", { body: { code, label, ratePercent } });

beforeEach(async () => {
  await truncateRefundTables();
  __resetAuthzCacheForTests();
});
afterAll(async () => {
  await truncateRefundTables();
});

describe("percent and basis-point conversion", () => {
  it("is exact, with no float", () => {
    expect(percentToBasisPoints("8.1")).toBe(810);
    expect(percentToBasisPoints("8")).toBe(800);
    expect(percentToBasisPoints("8.10")).toBe(810);
    expect(percentToBasisPoints("7.7")).toBe(770);
    expect(percentToBasisPoints("0")).toBe(0);
    expect(percentToBasisPoints("100")).toBe(10000);
    expect(percentToBasisPoints("0.07")).toBe(7);
    expect(() => percentToBasisPoints("100.01")).toThrow(RangeError);
    expect(() => percentToBasisPoints("8.123")).toThrow(RangeError);
    expect(basisPointsToPercent(810)).toBe("8.1");
    expect(basisPointsToPercent(805)).toBe("8.05");
    expect(basisPointsToPercent(0)).toBe("0");
    expect(basisPointsToPercent(10000)).toBe("100");
    expect(basisPointsToPercent(7)).toBe("0.07");
  });
});

describe("ledger accounts", () => {
  it("(AC-1.1, AC-1.8) adds an account, active, with the actor from the JWT and a creation step in its history", async () => {
    const res = await call("POST", "/accounting/ledger-accounts", {
      body: { number: " 5905 ", name: "  Spese  ", createdByEmail: "attacker@x.com", createdByUserId: "x" },
      sub: "admin-7",
      email: "carla@welld.ch",
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ number: "5905", name: "Spese", active: true, createdByEmail: "carla@welld.ch" });
    expect(res.body["history"]).toEqual([{ active: true, at: res.body["createdAt"], byEmail: "carla@welld.ch" }]);
    const row = await db.ledgerAccount.findUniqueOrThrow({ where: { id: res.body["id"] } });
    expect(row.createdByUserId).toBe("admin-7");
    expect(row.entity).toBe("welld_ch");

    const list = await call("GET", "/accounting/ledger-accounts");
    expect(list.status).toBe(200);
    expect((list.body["items"] as { number: string }[]).map((i) => i.number)).toEqual(["5905"]);
  });

  it("lists by number, numerically, with decimals after their parent", async () => {
    for (const number of ["5905", "599", "2620.1", "2620"]) await addAccount(number, `Account ${number}`);
    const list = await call("GET", "/accounting/ledger-accounts");
    expect((list.body["items"] as { number: string }[]).map((i) => i.number)).toEqual(["599", "2620", "2620.1", "5905"]);
  });

  it("(AC-1.2) refuses a second account with the same number, naming it, also when the first is deactivated", async () => {
    const first = await addAccount();
    const dup = await addAccount("5905", "Another name");
    expect(dup.status).toBe(409);
    expect(dup.body["code"]).toBe("ledger_account_duplicate");
    expect(dup.body["detail"]).toBe("Account 5905 already exists");

    expect((await call("POST", `/accounting/ledger-accounts/${first.body["id"]}/deactivate`)).status).toBe(200);
    const again = await addAccount("5905", "Third");
    expect(again.status).toBe(409);
    expect(again.body["code"]).toBe("ledger_account_duplicate");
    expect(await db.ledgerAccount.count()).toBe(1);
  });

  it("(AC-1.2) two concurrent adds of one number: one 201, one 409", async () => {
    const results = await Promise.all([addAccount("6101", "A"), addAccount("6101", "B"), addAccount("6101", "C")]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    for (const r of results.filter((r) => r.status === 409)) expect(r.body["code"]).toBe("ledger_account_duplicate");
    expect(await db.ledgerAccount.count()).toBe(1);
  });

  it("refuses malformed input with 422 invalid_ledger_account and writes nothing", async () => {
    for (const body of [
      { number: "12", name: "x" },
      { number: "1234567", name: "x" },
      { number: "59 05", name: "x" },
      { number: "5905.1234", name: "x" },
      { number: "5905", name: "   " },
      { number: "5905", name: "x".repeat(121) },
      { number: "5905" },
    ]) {
      const res = await call("POST", "/accounting/ledger-accounts", { body });
      expect(res.status).toBe(422);
      expect(res.body["code"]).toBe("invalid_ledger_account");
    }
    expect(await db.ledgerAccount.count()).toBe(0);
  });

  it("accepts the decimal form 2620.1 and a 120-character name", async () => {
    expect((await addAccount("2620.1", "n".repeat(120))).status).toBe(201);
  });

  it("(AC-1.8, AC-1.9) deactivate then reactivate: same number and name, history before -> after with actors", async () => {
    const created = await addAccount();
    const id = created.body["id"] as string;
    const off = await call("POST", `/accounting/ledger-accounts/${id}/deactivate`, { email: "off@welld.ch" });
    expect(off.status).toBe(200);
    expect(off.body["active"]).toBe(false);
    const on = await call("POST", `/accounting/ledger-accounts/${id}/reactivate`, { email: "on@welld.ch" });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ active: true, number: "5905", name: "Spese rimborsi chilometrici", id });
    const history = on.body["history"] as { active: boolean; at: string; byEmail: string }[];
    expect(history.map((h) => [h.active, h.byEmail])).toEqual([
      [true, "admin@welld.ch"],
      [false, "off@welld.ch"],
      [true, "on@welld.ch"],
    ]);
    const times = history.map((h) => Date.parse(h.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(new Set(times).size).toBe(3);
    expect(await db.accountingCatalogStatus.count()).toBe(2);
  });

  it("(AC-1.9) a classified line keeps its account through deactivate and reactivate", async () => {
    const created = await addAccount();
    const id = created.body["id"] as string;
    const request = await db.refundRequest.create({ data: { ownerUserId: "o", ownerEmail: "o@welld.ch", status: "submitted" } });
    const line = await db.refundLine.create({
      data: {
        requestId: request.id, date: new Date("2026-03-02"), type: "travel_train", motivo: "m", entity: "welld_ch",
        currency: "CHF", requestedAmountCents: 100, ledgerAccountId: id, ledgerAccountIsDefault: false,
      },
    });
    await call("POST", `/accounting/ledger-accounts/${id}/deactivate`);
    await call("POST", `/accounting/ledger-accounts/${id}/reactivate`);
    expect((await db.refundLine.findUniqueOrThrow({ where: { id: line.id } })).ledgerAccountId).toBe(id);
  });

  it("(AC-1.11) reactivating an active account, or deactivating an inactive one, is a 409 that writes no row", async () => {
    const id = (await addAccount()).body["id"] as string;
    const again = await call("POST", `/accounting/ledger-accounts/${id}/reactivate`);
    expect(again.status).toBe(409);
    expect(again.body["code"]).toBe("already_active");
    expect(again.body["detail"]).toBe("Account 5905 is already active");
    expect(await db.accountingCatalogStatus.count()).toBe(0);

    await call("POST", `/accounting/ledger-accounts/${id}/deactivate`);
    const twice = await call("POST", `/accounting/ledger-accounts/${id}/deactivate`);
    expect(twice.status).toBe(409);
    expect(twice.body["code"]).toBe("already_inactive");
    expect(await db.accountingCatalogStatus.count()).toBe(1);
  });

  it("(AC-1.11) concurrent reactivations of an inactive account: exactly one wins", async () => {
    const id = (await addAccount()).body["id"] as string;
    await call("POST", `/accounting/ledger-accounts/${id}/deactivate`);
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => call("POST", `/accounting/ledger-accounts/${id}/reactivate`)),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    expect(await db.accountingCatalogStatus.count()).toBe(2);
  });

  it("404 for an unknown account, and for a VAT code id on the account route", async () => {
    expect((await call("POST", "/accounting/ledger-accounts/nope/deactivate")).status).toBe(404);
    const vatId = (await addVat()).body["id"] as string;
    expect((await call("POST", `/accounting/ledger-accounts/${vatId}/deactivate`)).status).toBe(404);
    expect((await call("POST", `/accounting/vat-codes/nope/reactivate`)).status).toBe(404);
  });
});

describe("VAT codes", () => {
  it("(AC-1.4) adds a code, upper-cased, with the rate in basis points", async () => {
    const res = await addVat("imp81", "8.1");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ code: "IMP81", rateBasisPoints: 810, ratePercent: "8.1", active: true, label: "IVA 8.1%" });
    const list = await call("GET", "/accounting/vat-codes");
    expect((list.body["items"] as unknown[]).length).toBe(1);
  });

  it("(AC-1.4) accepts 0 and 100, refuses -1, 100.01, 8.123 and non-numbers with 422 invalid_vat_code", async () => {
    expect((await addVat("ZERO", "0")).body["rateBasisPoints"]).toBe(0);
    expect((await addVat("FULL", "100")).body["rateBasisPoints"]).toBe(10000);
    expect((await addVat("SEVEN", "7.70")).body["rateBasisPoints"]).toBe(770);
    for (const ratePercent of ["-1", "100.01", "8.123", "abc", "", "1e2", " ", "1000", ".5"]) {
      const res = await addVat("BAD", ratePercent);
      expect(res.status).toBe(422);
      expect(res.body["code"]).toBe("invalid_vat_code");
    }
    for (const code of ["", "has space", "WAY_TOO_LONG_CODE_X", "ü"]) {
      expect((await addVat(code, "8")).status).toBe(422);
    }
    expect((await call("POST", "/accounting/vat-codes", { body: { code: "X", label: "l" } })).status).toBe(422);
    expect(await db.vatCode.count()).toBe(3);
  });

  it("(AC-1.4) a duplicate code is a 409 naming it, also when the code differs only in case or is deactivated", async () => {
    const first = await addVat("IMP81");
    const dup = await addVat("imp81", "7.7");
    expect(dup.status).toBe(409);
    expect(dup.body["code"]).toBe("vat_code_duplicate");
    expect(dup.body["detail"]).toBe("VAT code IMP81 already exists");
    await call("POST", `/accounting/vat-codes/${first.body["id"]}/deactivate`);
    expect((await addVat("IMP81")).status).toBe(409);
    expect(await db.vatCode.count()).toBe(1);
  });

  it("(AC-1.4) concurrent adds of one code: one 201, the rest 409", async () => {
    const results = await Promise.all([addVat("RACE"), addVat("RACE"), addVat("RACE")]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
  });

  it("(AC-1.10) deactivate then reactivate keeps code, label and rate; history is before -> after", async () => {
    const id = (await addVat("IMP81", "8.1", "IVA 8.1%")).body["id"] as string;
    await call("POST", `/accounting/vat-codes/${id}/deactivate`);
    const on = await call("POST", `/accounting/vat-codes/${id}/reactivate`, { email: "back@welld.ch" });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ active: true, code: "IMP81", label: "IVA 8.1%", rateBasisPoints: 810 });
    expect((on.body["history"] as { active: boolean }[]).map((h) => h.active)).toEqual([true, false, true]);
  });

  it("(AC-1.11) reactivating an active code is a 409 with its message and no new row", async () => {
    const id = (await addVat()).body["id"] as string;
    const res = await call("POST", `/accounting/vat-codes/${id}/reactivate`);
    expect(res.status).toBe(409);
    expect(res.body["code"]).toBe("already_active");
    expect(res.body["detail"]).toBe("VAT code IMP81 is already active");
    expect(await db.accountingCatalogStatus.count()).toBe(0);
  });
});

describe("(AC-1.5) there is no way to change an entry", () => {
  it("PUT, PATCH and DELETE on an account or a VAT code answer 404", async () => {
    const acc = (await addAccount()).body["id"] as string;
    const vat = (await addVat()).body["id"] as string;
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      for (const path of [
        `/accounting/ledger-accounts/${acc}`,
        `/accounting/vat-codes/${vat}`,
        "/accounting/vat-codes",
        "/accounting/ledger-accounts",
      ]) {
        const res = await call(method, path, { body: { ratePercent: "9", name: "x" } });
        expect(res.status).toBe(404);
      }
    }
    const row = await db.vatCode.findUniqueOrThrow({ where: { id: vat } });
    expect(row.rateBasisPoints).toBe(810);
  });
});

describe("(AC-1.7) capability gates", () => {
  it("no token is 401 on every path, the base path included", async () => {
    for (const [method, path] of [
      ["GET", "/accounting/ledger-accounts"],
      ["POST", "/accounting/ledger-accounts"],
      ["GET", "/accounting/vat-codes"],
      ["POST", "/accounting/vat-codes/x/reactivate"],
    ] as const) {
      expect((await call(method, path, { token: false, body: {} })).status).toBe(401);
    }
  });

  it("without settings:read every GET is 403, even for a holder of manage", async () => {
    for (const as of [NONE, MANAGE]) {
      expect((await call("GET", "/accounting/ledger-accounts", { as })).status).toBe(403);
      expect((await call("GET", "/accounting/vat-codes", { as })).status).toBe(403);
    }
  });

  it("without settings:manage add, deactivate and reactivate are 403 before the body is looked at", async () => {
    const acc = (await addAccount()).body["id"] as string;
    const vat = (await addVat()).body["id"] as string;
    for (const as of [NONE, READ]) {
      expect((await call("POST", "/accounting/ledger-accounts", { as, body: { number: "6101", name: "x" } })).status).toBe(403);
      expect((await call("POST", "/accounting/ledger-accounts", { as, body: {} })).status).toBe(403);
      expect((await call("POST", "/accounting/vat-codes", { as, body: { code: "X", label: "l", ratePercent: "1" } })).status).toBe(403);
      expect((await call("POST", `/accounting/ledger-accounts/${acc}/deactivate`, { as })).status).toBe(403);
      expect((await call("POST", `/accounting/ledger-accounts/${acc}/reactivate`, { as })).status).toBe(403);
      expect((await call("POST", `/accounting/vat-codes/${vat}/deactivate`, { as })).status).toBe(403);
      expect((await call("POST", `/accounting/vat-codes/${vat}/reactivate`, { as })).status).toBe(403);
    }
    expect(await db.accountingCatalogStatus.count()).toBe(0);
    expect(await db.ledgerAccount.count()).toBe(1);
  });

  it("a holder of read alone can list", async () => {
    expect((await call("GET", "/accounting/ledger-accounts", { as: READ })).status).toBe(200);
    expect((await call("GET", "/accounting/vat-codes", { as: READ })).status).toBe(200);
  });

  it("a body over 4 KiB is a 413", async () => {
    const res = await call("POST", "/accounting/ledger-accounts", { raw: JSON.stringify({ number: "5905", name: "x".repeat(5000) }) });
    expect(res.status).toBe(413);
  });
});
