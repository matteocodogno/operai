/**
 * Integration tests for the defaults endpoints (T7, specs/20261118-refund-accounting-export; reworked by T18,
 * specs/20261119-accounting, plan § API contracts "Defaults" and the Test strategy rows; by T61 for the 2026-11-19 sign-off:
 * default ACCOUNTS only, 20261118 SO-16).
 *
 * Real Postgres, jwt/authz mocked, a FAKE `AccountingPort` (no network). Plan rows:
 *   AC-4.4  a settings:manage holder with no Accounting grant: PUT a default with a deactivated or unknown account is 422
 *           and no row is written; only active accounts are accepted
 *   AC-4.5  GET returns the fourteen types with copies and states (active / deactivated / not_found); a default that is not
 *           active counts as none
 *   AC-4.7  the history keeps the copies as saved, whatever Accounting does afterwards; the table is immutable
 *   AC-6.9  Accounting unreachable (each kind): GET is 200 with the recorded copies, state unverified, accounting
 *           "unavailable"; PUT is 503 accounting_unavailable with Retry-After, nothing written
 *   AC-3.7  second half: an Accounting manager without settings:manage gets 403 on the PUT
 *   AC-6.10 no refusal body carries a URL, a host, a cuid or a stack
 *   AC-4.8  nothing is cached: two consecutive reads see a change made between them, and the fake counts two reads
 *   20261118 AC-2.1 to AC-2.4, AC-2.8: account-only rows; a body with `vatCode` is a 422; no designation anywhere
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
process.env["ACCOUNTING_INTERNAL_URL"] = "http://localhost:8089";
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

const { defaultsRouter } = await import("./defaults.routes");
const { loadRecordedDefaults, EXPENSE_TYPES } = await import("./defaults.repo");
const { EXPENSE_TYPE_VALUES } = await import("./defaults.schemas");
const { ACCOUNTING_FAILURE_KINDS } = await import("./accountingClient");
const { createFakeAccounting, useFakeAccounting, restoreAccounting } = await import("../test-support/fakeAccounting");
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
/** An Accounting manager who is NOT a Refund admin (AC-3.7): `accounting:manage` opens nothing in Refund's settings. */
const ACCOUNTING_MANAGER: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [
    { resource: "refund", action: "access", conditions: null },
    { resource: "accounting", action: "manage", conditions: null },
    { resource: "accounting", action: "read", conditions: null },
  ],
  entity: null,
  jobTitle: null,
};

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; as?: ResolveResponse; sub?: string; email?: string; token?: boolean } = {},
) {
  __resetAuthzCacheForTests();
  harness.setResolve(async () => opts.as ?? BOTH);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token !== false) {
    headers["Authorization"] = `Bearer ${await harness.signToken({ sub: opts.sub ?? "admin-1", email: opts.email ?? "admin@welld.ch" })}`;
  }
  const res = await defaultsRouter.request(path, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let body: Record<string, any> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, any>) : {};
  } catch {
    body = { text };
  }
  return { status: res.status, body, headers: res.headers };
}

/** AC-6.10: a refusal names the cause and carries no address, identifier or internal text. */
const NO_INTERNALS = /https?:\/\/(?!httpstatuses\.com)|localhost|railway|\bc[a-z0-9]{24}\b|\bat .*\(/;
const expectClean = (body: unknown) => expect(JSON.stringify(body)).not.toMatch(NO_INTERNALS);

const fake = createFakeAccounting();
const putType = (type: string, accountNumber: string | null, extra: Parameters<typeof call>[2] = {}) =>
  call("PUT", `/accounting/expense-type-defaults/${type}`, { body: { accountNumber }, ...extra });
const getDefaults = (extra: Parameters<typeof call>[2] = {}) => call("GET", "/accounting/expense-type-defaults", extra);

beforeEach(async () => {
  await truncateRefundTables({ released: false });
  __resetAuthzCacheForTests();
  fake.failWith(null).failReferenceDataWith(null).failRatesWith(null).setDelayMs(0).onRead(null).resetCalls();
  for (const a of ["5901", "5904", "6101", "9999"]) fake.removeAccount(a);
  for (const v of ["IMP81", "IMP77", "NOVAT", "EXPORT"]) fake.removeVatCode(v);
  fake
    .setAccount("5901", "Treno")
    .setAccount("5904", "Altri trasporti")
    .setAccount("6101", "Ufficio")
    .setVatCode("IMP81", "IVA 8.1%", 810);
  useFakeAccounting(fake);
});
afterAll(async () => {
  restoreAccounting();
  await truncateRefundTables({ released: false });
});

const types = (res: { body: Record<string, any> }) => res.body["types"] as any[];
const typeRow = (res: { body: Record<string, any> }, type: string) => types(res).find((t) => t.type === type);

describe("GET (AC-4.5, AC-2.2 of 20261118)", () => {
  it("always returns the fourteen types in enum order, null where unset, with nothing of VAT and no designation", async () => {
    const res = await getDefaults();
    expect(res.status).toBe(200);
    expect(res.body["entity"]).toBe("welld_ch");
    expect(res.body["accounting"]).toBe("available");
    expect(types(res).map((t) => t.type)).toEqual([...EXPENSE_TYPES]);
    expect(types(res)).toHaveLength(14);
    expect(types(res).map((t) => t.type)).toContain("travel_flight");
    expect(types(res).map((t) => t.type)).toContain("travel_taxi");
    for (const row of types(res)) {
      expect(row).toEqual({ type: row.type, account: null, updatedAt: null, updatedByEmail: null, history: [] });
    }
    expect(Object.keys(res.body).sort()).toEqual(["accounting", "entity", "types"]);
  });

  it("the schema's type list is the Prisma enum, in the same order", () => {
    expect([...EXPENSE_TYPE_VALUES]).toEqual([...EXPENSE_TYPES]);
  });

  it("(AC-4.5, SA-3) shows each default as recorded with Accounting's state: active, deactivated, not found", async () => {
    await putType("travel_train", "5901");
    await putType("postal", "5904");
    await putType("telephone", "6101");
    fake.setAccountActive("5901", false); // deactivated
    fake.removeAccount("5904"); // no longer found

    const res = await getDefaults();
    expect(typeRow(res, "travel_train")).toMatchObject({ account: { number: "5901", name: "Treno", state: "deactivated" } });
    expect(typeRow(res, "postal")).toMatchObject({ account: { number: "5904", name: "Altri trasporti", state: "not_found" } });
    expect(typeRow(res, "telephone")).toMatchObject({ account: { number: "6101", state: "active" } });
    // Reactivated: usable again with no further step (AC-1.10).
    fake.setAccountActive("5901", true);
    expect(typeRow(await getDefaults(), "travel_train").account.state).toBe("active");
  });
});

describe("PUT a type default (AC-4.4, AC-4.7)", () => {
  it("saves the account as a copy, shows it with who and when, and keeps every change in the history", async () => {
    const first = await putType("travel_train", "5901", { email: "one@welld.ch" });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      type: "travel_train",
      account: { number: "5901", name: "Treno", state: "active" },
      updatedByEmail: "one@welld.ch",
    });
    expect(first.body).not.toHaveProperty("vatCode");
    const second = await putType("travel_train", "5904", { email: "two@welld.ch" });
    expect(second.body["account"]).toMatchObject({ number: "5904" });
    const history = second.body["history"] as any[];
    expect(history.map((h) => [h.account?.number ?? null, h.byEmail])).toEqual([
      ["5901", "one@welld.ch"],
      ["5904", "two@welld.ch"],
    ]);
    expect(Date.parse(history[1].at)).toBeGreaterThan(Date.parse(history[0].at));
    expect(typeRow(await getDefaults(), "travel_train").history).toHaveLength(2);
  });

  it("the two new types take a default like any other (AC-8.3 of 20261118)", async () => {
    expect((await putType("travel_flight", "5901")).body).toMatchObject({ type: "travel_flight", account: { number: "5901" } });
    expect((await putType("travel_taxi", "5904")).body).toMatchObject({ type: "travel_taxi", account: { number: "5904" } });
  });

  it("(AC-4.7) the history reads the same after Accounting deactivates, renames, re-enters or becomes unreachable", async () => {
    await putType("travel_train", "5901", { email: "one@welld.ch" });
    const recorded = typeRow(await getDefaults(), "travel_train").history;

    fake.setAccountActive("5901", false);
    expect(typeRow(await getDefaults(), "travel_train").history).toEqual(recorded);
    fake.setAccount("5901", "A completely different name");
    expect(typeRow(await getDefaults(), "travel_train").history).toEqual(recorded);
    fake.removeAccount("5901");
    expect(typeRow(await getDefaults(), "travel_train").history).toEqual(recorded);
    fake.failWith("timeout");
    const down = await getDefaults();
    expect(down.status).toBe(200);
    expect(typeRow(down, "travel_train").history).toEqual(recorded);
    expect(recorded[0]).toMatchObject({ account: { number: "5901", name: "Treno" } });
  });

  it("(AC-2.1, SO-16) a body that carries `vatCode` is a 422, with or without the account, and writes nothing", async () => {
    for (const body of [
      { accountNumber: "5901", vatCode: null },
      { accountNumber: "5901", vatCode: "IMP81" },
      { vatCode: "IMP81" },
      { accountNumber: null, vatCode: null },
    ]) {
      const res = await call("PUT", "/accounting/expense-type-defaults/postal", { body });
      expect([res.status, res.body["code"]]).toEqual([422, "invalid_default"]);
    }
    expect(await db.expenseTypeAccountingDefault.count()).toBe(0);
  });

  it("takes the actor from the JWT and never from the body", async () => {
    const res = await call("PUT", "/accounting/expense-type-defaults/postal", {
      body: { accountNumber: "5901", createdByEmail: "attacker@x.ch", createdByUserId: "x" },
      sub: "admin-9",
      email: "real@welld.ch",
    });
    expect(res.status).toBe(422); // unknown keys are refused, so a spoofed actor never even reaches the repo
    await putType("postal", "5901", { sub: "admin-9", email: "real@welld.ch" });
    const row = await db.expenseTypeAccountingDefault.findFirstOrThrow();
    expect(row).toMatchObject({ createdByUserId: "admin-9", createdByEmail: "real@welld.ch", entity: "welld_ch", type: "postal" });
    expect(Object.keys(row).filter((key) => /vat/i.test(key))).toEqual([]); // the VAT columns are gone
  });

  it("clears the account with null (a row, not a no-op)", async () => {
    await putType("postal", "5901");
    const cleared = await putType("postal", null);
    expect(cleared.status).toBe(200);
    expect(cleared.body["account"]).toBeNull();
    expect((cleared.body["history"] as any[]).map((h) => h.account?.number ?? null)).toEqual(["5901", null]);
    expect(await db.expenseTypeAccountingDefault.count()).toBe(2);
  });

  it("suppresses a no-op: the same account again, and null on a type never set, write no row", async () => {
    await putType("postal", "5901");
    const again = await putType("postal", "5901");
    expect(again.status).toBe(200);
    expect((again.body["history"] as unknown[]).length).toBe(1);
    expect((await putType("telephone", null)).status).toBe(200);
    expect(await db.expenseTypeAccountingDefault.count()).toBe(1);
  });

  it("a re-saved key whose Accounting name changed records a new copy (the history shows both)", async () => {
    await putType("postal", "5901");
    fake.setAccount("5901", "Treno e bus");
    const again = await putType("postal", "5901");
    expect(again.body["account"]).toMatchObject({ name: "Treno e bus" });
    expect((again.body["history"] as any[]).map((h) => h.account.name)).toEqual(["Treno", "Treno e bus"]);
  });

  it("concurrent identical saves write one row", async () => {
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => putType("postal", "5901")));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await db.expenseTypeAccountingDefault.count()).toBe(1);
  });

  it("(AC-4.4, AC-1.4) refuses a deactivated account with 422 and writes nothing", async () => {
    fake.setAccountActive("5901", false);
    const bad = await putType("postal", "5901");
    expect(bad.status).toBe(422);
    expect(bad.body["code"]).toBe("ledger_account_inactive");
    expectClean(bad.body);
    expect(await db.expenseTypeAccountingDefault.count()).toBe(0);
  });

  it("(AC-4.4) refuses an unknown key with 422 *_not_found, including one that exists only for WellD Italia", async () => {
    fake.setItalianAccount("9999", "Solo Italia");
    expect((await putType("postal", "nope")).body["code"]).toBe("ledger_account_not_found");
    expect((await putType("postal", "9999")).body["code"]).toBe("ledger_account_not_found");
    const unknown = await putType("postal", "nope");
    expect(unknown.status).toBe(422);
    expectClean(unknown.body);
    expect(unknown.body["detail"]).not.toContain("nope"); // the refusal does not echo what was typed
    expect(await db.expenseTypeAccountingDefault.count()).toBe(0);
  });

  it("(AC-1.9, AC-1.10) a reactivated account can be chosen again", async () => {
    fake.setAccountActive("5901", false);
    expect((await putType("postal", "5901")).status).toBe(422);
    fake.setAccountActive("5901", true);
    expect((await putType("postal", "5901")).status).toBe(200);
  });

  it("an account deactivated AFTER it became the default stays recorded and is shown deactivated; saving it again is refused", async () => {
    await putType("postal", "5901");
    fake.setAccountActive("5901", false);
    expect(typeRow(await getDefaults(), "postal").account).toMatchObject({ number: "5901", state: "deactivated" });
    expect((await putType("postal", "5901")).status).toBe(422);
  });

  it("is a 404 for something that is not an expense type, and 422 for a missing key, an empty key or the old id body", async () => {
    expect((await putType("not_a_type", null)).status).toBe(404);
    expect((await call("PUT", "/accounting/expense-type-defaults/postal", { body: { accountNumber: "" } })).status).toBe(422);
    expect((await call("PUT", "/accounting/expense-type-defaults/postal", { body: {} })).status).toBe(422);
    expect((await call("PUT", "/accounting/expense-type-defaults/postal", { body: { ledgerAccountId: "x" } })).status).toBe(422);
  });

  it("(AC-4.7) the table is immutable at the database", async () => {
    await putType("postal", "5901");
    await expect(Promise.resolve(db.$executeRawUnsafe(`UPDATE "expense_type_accounting_default" SET "accountNumber" = NULL`))).rejects.toThrow();
    await expect(Promise.resolve(db.$executeRawUnsafe(`DELETE FROM "expense_type_accounting_default"`))).rejects.toThrow();
  });
});

describe("(AC-2.5 to AC-2.7 of 20261118, retired) no designation anywhere", () => {
  it("PUT /accounting/foreign-currency-vat-code is not a route: 404 for a settings:manage holder, and the same without a token", async () => {
    for (const method of ["PUT", "GET", "POST", "DELETE"]) {
      const withToken = await call(method, "/accounting/foreign-currency-vat-code", { ...(method === "PUT" ? { body: { vatCode: null } } : {}) });
      expect([method, withToken.status]).toEqual([method, 404]);
      const bare = await call(method, "/accounting/foreign-currency-vat-code", { token: false });
      expect([method, bare.status]).toEqual([method, 404]);
    }
    expect(fake.reads.total).toBe(0);
  });

  it("the table is gone from the database, and no VAT column is left on the defaults", async () => {
    const tables = await db.$queryRawUnsafe<{ tablename: string }[]>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'foreign_currency_vat_designation'`);
    expect(tables).toEqual([]);
    const columns = await db.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'expense_type_accounting_default' AND column_name LIKE 'vat%'`,
    );
    expect(columns).toEqual([]);
  });
});

describe("(AC-6.9) Accounting unreachable", () => {
  for (const kind of ACCOUNTING_FAILURE_KINDS) {
    it(`${kind}: GET is 200 with the recorded copies, state unverified and accounting "unavailable"; PUT is 503 with Retry-After and writes nothing`, async () => {
      await putType("travel_train", "5901");
      const rows = await db.expenseTypeAccountingDefault.count();
      fake.failWith(kind);

      const view = await getDefaults();
      expect(view.status).toBe(200);
      expect(view.body["accounting"]).toBe("unavailable");
      expect(typeRow(view, "travel_train")).toMatchObject({ account: { number: "5901", name: "Treno", state: "unverified" } });
      expect(typeRow(view, "postal")).toMatchObject({ account: null });

      for (const res of [await putType("postal", "5901"), await putType("postal", null)]) {
        expect(res.status).toBe(503);
        expect(res.body["code"]).toBe("accounting_unavailable");
        expect(res.headers.get("Retry-After")).toBe("30");
        expectClean(res.body);
      }
      expect(await db.expenseTypeAccountingDefault.count()).toBe(rows);
    });
  }

  it("back to reachable, the same save works", async () => {
    fake.failWith("network");
    expect((await putType("postal", "5901")).status).toBe(503);
    fake.failWith(null);
    expect((await putType("postal", "5901")).status).toBe(200);
  });
});

describe("(AC-4.8) no cache: every operation reads afresh", () => {
  it("two consecutive reads see a change made between them, and the fake counts two reads", async () => {
    await putType("postal", "5901");
    fake.resetCalls();
    expect(typeRow(await getDefaults(), "postal").account.state).toBe("active");
    fake.setAccountActive("5901", false);
    expect(typeRow(await getDefaults(), "postal").account.state).toBe("deactivated");
    expect(fake.reads).toEqual({ referenceData: 2, rates: 0, total: 2 });
  });

  it("one PUT reads once, and never reads rates", async () => {
    fake.resetCalls();
    await putType("postal", "5901");
    expect(fake.reads).toEqual({ referenceData: 1, rates: 0, total: 1 });
  });
});

describe("capability gates (AC-3.7, AC-2.8 of 20261118)", () => {
  it("no token is 401", async () => {
    expect((await getDefaults({ token: false })).status).toBe(401);
    expect((await putType("postal", null, { token: false })).status).toBe(401);
  });

  it("GET needs settings:read, and manage alone is not enough", async () => {
    for (const as of [NONE, MANAGE]) expect((await getDefaults({ as })).status).toBe(403);
    expect((await getDefaults({ as: READ })).status).toBe(200);
  });

  it("the PUT needs settings:manage, checked before the body, and before Accounting is read", async () => {
    fake.resetCalls();
    for (const as of [NONE, READ]) {
      expect((await putType("postal", "5901", { as })).status).toBe(403);
      expect((await call("PUT", "/accounting/expense-type-defaults/postal", { as, body: {} })).status).toBe(403);
      expect((await call("PUT", "/accounting/expense-type-defaults/postal", { as, body: { vatCode: "IMP81" } })).status).toBe(403);
    }
    expect(await db.expenseTypeAccountingDefault.count()).toBe(0);
    expect(fake.reads.total).toBe(0);
  });

  it("(AC-3.7) an Accounting manager without settings:manage is refused on the PUT, and cannot read the settings either", async () => {
    expect((await putType("postal", "5901", { as: ACCOUNTING_MANAGER })).status).toBe(403);
    expect((await getDefaults({ as: ACCOUNTING_MANAGER })).status).toBe(403);
    expect(await db.expenseTypeAccountingDefault.count()).toBe(0);
  });

  it("(AC-4.4) a settings:manage holder with no Accounting grant can choose from Accounting's active accounts", async () => {
    expect((await putType("postal", "5901", { as: MANAGE })).status).toBe(200);
  });
});

describe("loadRecordedDefaults (what approval, release, the view and the export resolve against)", () => {
  it("returns each type's latest recorded account copy, as recorded, and nothing else", async () => {
    await putType("travel_train", "5901");
    await putType("travel_train", "6101");
    await putType("postal", "5901");
    await putType("postal", null);
    fake.setAccountActive("6101", false); // state is not the repo's business: the copy comes back as recorded

    const recorded = await db.$transaction((tx) => loadRecordedDefaults(tx));
    expect(recorded).toEqual({
      defaults: { travel_train: { account: { number: "6101", name: "Ufficio" } }, postal: { account: null } },
    });
    expect(recorded.defaults.telephone).toBeUndefined();
  });

  it("is empty before anything is configured", async () => {
    expect(await loadRecordedDefaults()).toEqual({ defaults: {} });
  });
});
