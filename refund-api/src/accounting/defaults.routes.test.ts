/**
 * Integration tests for the defaults endpoints (T7, specs/20261118-refund-accounting-export; reworked by T18,
 * specs/20261119-accounting, plan § API contracts "Defaults" and the Test strategy rows).
 *
 * Real Postgres, jwt/authz mocked, a FAKE `AccountingPort` (no network). Plan rows:
 *   AC-4.4  a settings:manage holder with no Accounting grant: PUT defaults / designation with a deactivated or unknown
 *           entry is 422 and no row is written; only active entries are accepted
 *   AC-4.5  GET returns the twelve types with copies and states (active / deactivated / not_found); a default that is not
 *           active counts as none; the designation likewise
 *   AC-4.7  the history keeps the copies as saved, whatever Accounting does afterwards; both tables are immutable
 *   AC-6.9  Accounting unreachable (each kind): GET is 200 with the recorded copies, state unverified, accounting
 *           "unavailable"; PUT is 503 accounting_unavailable with Retry-After, nothing written
 *   AC-3.7  second half: an Accounting manager without settings:manage gets 403 on both PUTs
 *   AC-6.10 no refusal body carries a URL, a host, a cuid or a stack
 *   AC-4.8  nothing is cached: two consecutive reads see a change made between them, and the fake counts two reads
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
const { getSettingDescriptor } = await import("../settings/registry");
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
const putType = (type: string, accountNumber: string | null, vatCode: string | null, extra: Parameters<typeof call>[2] = {}) =>
  call("PUT", `/accounting/expense-type-defaults/${type}`, { body: { accountNumber, vatCode }, ...extra });
const putDesignation = (vatCode: string | null, extra: Parameters<typeof call>[2] = {}) =>
  call("PUT", "/accounting/foreign-currency-vat-code", { body: { vatCode }, ...extra });
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
    .setVatCode("IMP81", "IVA 8.1%", 810)
    .setVatCode("IMP77", "IVA 7.7%", 770)
    .setVatCode("NOVAT", "Senza IVA", 0)
    .setVatCode("EXPORT", "Export", 0);
  useFakeAccounting(fake);
});
afterAll(async () => {
  restoreAccounting();
  await truncateRefundTables({ released: false });
});

const types = (res: { body: Record<string, any> }) => res.body["types"] as any[];
const typeRow = (res: { body: Record<string, any> }, type: string) => types(res).find((t) => t.type === type);

describe("GET (AC-4.5, AC-2.2 of 20261118)", () => {
  it("always returns the twelve types in enum order, null where unset, with no designation", async () => {
    const res = await getDefaults();
    expect(res.status).toBe(200);
    expect(res.body["entity"]).toBe("welld_ch");
    expect(res.body["accounting"]).toBe("available");
    expect(types(res).map((t) => t.type)).toEqual([...EXPENSE_TYPES]);
    expect(types(res)).toHaveLength(12);
    for (const row of types(res)) {
      expect(row).toMatchObject({ account: null, vatCode: null, updatedAt: null, updatedByEmail: null, history: [] });
    }
    expect(res.body["foreignCurrencyVatCode"]).toBeNull();
    expect(res.body["foreignCurrencyVatCodeUsable"]).toBe(false);
    expect(res.body["foreignCurrencyVatCodeHistory"]).toEqual([]);
  });

  it("the schema's type list is the Prisma enum, in the same order", () => {
    expect([...EXPENSE_TYPE_VALUES]).toEqual([...EXPENSE_TYPES]);
  });

  it("(AC-4.5, SA-3) shows each default as recorded with Accounting's state: active, deactivated, not found", async () => {
    await putType("travel_train", "5901", "IMP81");
    await putType("postal", "5904", "IMP77");
    await putType("telephone", "6101", "NOVAT");
    await putDesignation("EXPORT");
    fake.setAccountActive("5901", false); // deactivated
    fake.removeAccount("5904"); // no longer found
    fake.removeVatCode("IMP77"); // no longer found
    fake.setVatCodeActive("EXPORT", false);

    const res = await getDefaults();
    expect(typeRow(res, "travel_train")).toMatchObject({
      account: { number: "5901", name: "Treno", state: "deactivated" },
      vatCode: { code: "IMP81", label: "IVA 8.1%", ratePercent: "8.1", state: "active" },
    });
    expect(typeRow(res, "postal")).toMatchObject({
      account: { number: "5904", name: "Altri trasporti", state: "not_found" },
      vatCode: { code: "IMP77", ratePercent: "7.7", state: "not_found" },
    });
    expect(typeRow(res, "telephone")).toMatchObject({
      account: { number: "6101", state: "active" },
      vatCode: { code: "NOVAT", state: "active" },
    });
    expect(res.body["foreignCurrencyVatCode"]).toMatchObject({ code: "EXPORT", state: "deactivated" });
    expect(res.body["foreignCurrencyVatCodeUsable"]).toBe(false);

    // Reactivated: usable again with no further step (AC-1.10).
    fake.setVatCodeActive("EXPORT", true);
    const again = await getDefaults();
    expect(again.body["foreignCurrencyVatCode"]).toMatchObject({ code: "EXPORT", state: "active" });
    expect(again.body["foreignCurrencyVatCodeUsable"]).toBe(true);
  });
});

describe("PUT a type default (AC-4.4, AC-4.7)", () => {
  it("saves both halves as copies, shows them with who and when, and keeps every change in the history", async () => {
    const first = await putType("travel_train", "5901", "IMP81", { email: "one@welld.ch" });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      type: "travel_train",
      account: { number: "5901", name: "Treno", state: "active" },
      vatCode: { code: "IMP81", label: "IVA 8.1%", ratePercent: "8.1", state: "active" },
      updatedByEmail: "one@welld.ch",
    });
    const second = await putType("travel_train", "5904", null, { email: "two@welld.ch" });
    expect(second.body["account"]).toMatchObject({ number: "5904" });
    expect(second.body["vatCode"]).toBeNull();
    const history = second.body["history"] as any[];
    expect(history.map((h) => [h.account?.number ?? null, h.vatCode?.code ?? null, h.byEmail])).toEqual([
      ["5901", "IMP81", "one@welld.ch"],
      ["5904", null, "two@welld.ch"],
    ]);
    expect(Date.parse(history[1].at)).toBeGreaterThan(Date.parse(history[0].at));
    expect(typeRow(await getDefaults(), "travel_train").history).toHaveLength(2);
  });

  it("(AC-4.7) the history reads the same after Accounting deactivates, renames, re-enters or becomes unreachable", async () => {
    await putType("travel_train", "5901", "IMP81", { email: "one@welld.ch" });
    const recorded = typeRow(await getDefaults(), "travel_train").history;

    fake.setAccountActive("5901", false);
    expect(typeRow(await getDefaults(), "travel_train").history).toEqual(recorded);
    fake.setAccount("5901", "A completely different name");
    fake.setVatCode("IMP81", "Renamed", 810);
    expect(typeRow(await getDefaults(), "travel_train").history).toEqual(recorded);
    fake.removeAccount("5901");
    fake.removeVatCode("IMP81");
    expect(typeRow(await getDefaults(), "travel_train").history).toEqual(recorded);
    fake.failWith("timeout");
    const down = await getDefaults();
    expect(down.status).toBe(200);
    expect(typeRow(down, "travel_train").history).toEqual(recorded);
    expect(recorded[0]).toMatchObject({ account: { number: "5901", name: "Treno" }, vatCode: { code: "IMP81", label: "IVA 8.1%", ratePercent: "8.1" } });
  });

  it("takes the actor from the JWT and never from the body", async () => {
    const res = await call("PUT", "/accounting/expense-type-defaults/postal", {
      body: { accountNumber: "5901", vatCode: null, createdByEmail: "attacker@x.ch", createdByUserId: "x" },
      sub: "admin-9",
      email: "real@welld.ch",
    });
    expect(res.status).toBe(422); // unknown keys are refused, so a spoofed actor never even reaches the repo
    await putType("postal", "5901", null, { sub: "admin-9", email: "real@welld.ch" });
    const row = await db.expenseTypeAccountingDefault.findFirstOrThrow();
    expect(row).toMatchObject({ createdByUserId: "admin-9", createdByEmail: "real@welld.ch", entity: "welld_ch", type: "postal" });
  });

  it("clears a half with null (a row, not a no-op), and the other half stays", async () => {
    await putType("postal", "5901", "IMP81");
    const cleared = await putType("postal", "5901", null);
    expect(cleared.body["vatCode"]).toBeNull();
    expect(cleared.body["account"]).toMatchObject({ number: "5901" });
    expect(await db.expenseTypeAccountingDefault.count()).toBe(2);
  });

  it("suppresses a no-op: the same values again, and null/null on a type never set, write no row", async () => {
    await putType("postal", "5901", null);
    const again = await putType("postal", "5901", null);
    expect(again.status).toBe(200);
    expect((again.body["history"] as unknown[]).length).toBe(1);
    expect((await putType("telephone", null, null)).status).toBe(200);
    expect(await db.expenseTypeAccountingDefault.count()).toBe(1);
  });

  it("a re-saved key whose Accounting name changed records a new copy (the history shows both)", async () => {
    await putType("postal", "5901", null);
    fake.setAccount("5901", "Treno e bus");
    const again = await putType("postal", "5901", null);
    expect(again.body["account"]).toMatchObject({ name: "Treno e bus" });
    expect((again.body["history"] as any[]).map((h) => h.account.name)).toEqual(["Treno", "Treno e bus"]);
  });

  it("concurrent identical saves write one row", async () => {
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => putType("postal", "5901", null)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await db.expenseTypeAccountingDefault.count()).toBe(1);
  });

  it("(AC-4.4, AC-1.4, AC-1.8) refuses a deactivated account or VAT code with 422 and writes nothing", async () => {
    fake.setAccountActive("5901", false);
    fake.setVatCodeActive("IMP81", false);
    const badAccount = await putType("postal", "5901", "IMP77");
    expect(badAccount.status).toBe(422);
    expect(badAccount.body["code"]).toBe("ledger_account_inactive");
    const badVat = await putType("postal", "5904", "IMP81");
    expect(badVat.status).toBe(422);
    expect(badVat.body["code"]).toBe("vat_code_inactive");
    expectClean(badAccount.body);
    expectClean(badVat.body);
    expect(await db.expenseTypeAccountingDefault.count()).toBe(0);
  });

  it("(AC-4.4) refuses an unknown key with 422 *_not_found, including one that exists only for WellD Italia", async () => {
    fake.setItalianAccount("9999", "Solo Italia");
    expect((await putType("postal", "nope", null)).body["code"]).toBe("ledger_account_not_found");
    expect((await putType("postal", "9999", null)).body["code"]).toBe("ledger_account_not_found");
    expect((await putType("postal", null, "NOPE")).body["code"]).toBe("vat_code_not_found");
    expect((await putType("postal", null, "imp81")).body["code"]).toBe("vat_code_not_found"); // the key is exact
    const unknown = await putType("postal", "nope", null);
    expect(unknown.status).toBe(422);
    expectClean(unknown.body);
    expect(unknown.body["detail"]).not.toContain("nope"); // the refusal does not echo what was typed
    expect(await db.expenseTypeAccountingDefault.count()).toBe(0);
  });

  it("(AC-1.9, AC-1.10) a reactivated entry can be chosen again", async () => {
    fake.setAccountActive("5901", false);
    fake.setVatCodeActive("IMP81", false);
    expect((await putType("postal", "5901", "IMP81")).status).toBe(422);
    fake.setAccountActive("5901", true);
    fake.setVatCodeActive("IMP81", true);
    expect((await putType("postal", "5901", "IMP81")).status).toBe(200);
  });

  it("an entry deactivated AFTER it became the default stays recorded and is shown deactivated; saving it again is refused", async () => {
    await putType("postal", "5901", null);
    fake.setAccountActive("5901", false);
    expect(typeRow(await getDefaults(), "postal").account).toMatchObject({ number: "5901", state: "deactivated" });
    expect((await putType("postal", "5901", null)).status).toBe(422);
  });

  it("is a 404 for something that is not an expense type, and 422 for a missing key, an empty key or the old id body", async () => {
    expect((await putType("not_a_type", null, null)).status).toBe(404);
    expect((await call("PUT", "/accounting/expense-type-defaults/postal", { body: { accountNumber: null } })).status).toBe(422);
    expect((await call("PUT", "/accounting/expense-type-defaults/postal", { body: { accountNumber: "", vatCode: null } })).status).toBe(422);
    expect((await call("PUT", "/accounting/expense-type-defaults/postal", { body: {} })).status).toBe(422);
    expect((await call("PUT", "/accounting/expense-type-defaults/postal", { body: { ledgerAccountId: "x", vatCodeId: null } })).status).toBe(422);
  });

  it("(AC-4.7) both tables are immutable at the database", async () => {
    await putType("postal", "5901", null);
    await putDesignation("NOVAT");
    for (const table of ["expense_type_accounting_default", "foreign_currency_vat_designation"]) {
      await expect(Promise.resolve(db.$executeRawUnsafe(`UPDATE "${table}" SET "vatCode" = NULL`))).rejects.toThrow();
      await expect(Promise.resolve(db.$executeRawUnsafe(`DELETE FROM "${table}"`))).rejects.toThrow();
    }
  });
});

describe("the foreign-currency VAT code (AC-4.4, AC-4.5, AC-4.7)", () => {
  it("designates, shows the code, and keeps every designation in the history with actor and time", async () => {
    const first = await putDesignation("NOVAT", { email: "one@welld.ch" });
    expect(first.status).toBe(200);
    expect(first.body["foreignCurrencyVatCode"]).toMatchObject({ code: "NOVAT", label: "Senza IVA", ratePercent: "0", state: "active" });
    expect(first.body["foreignCurrencyVatCodeUsable"]).toBe(true);
    const second = await putDesignation("EXPORT", { email: "two@welld.ch" });
    const history = second.body["foreignCurrencyVatCodeHistory"] as any[];
    expect(history.map((h) => [h.vatCode.code, h.byEmail])).toEqual([["NOVAT", "one@welld.ch"], ["EXPORT", "two@welld.ch"]]);
    expect(Date.parse(history[1].at)).toBeGreaterThan(Date.parse(history[0].at));
    const view = await getDefaults();
    expect(view.body["foreignCurrencyVatCode"]).toMatchObject({ code: "EXPORT" });
    expect(view.body["foreignCurrencyVatCodeHistory"]).toHaveLength(2);
  });

  it("is stored in its own append-only table, as a copy, and not in the generic settings registry", async () => {
    await putDesignation("NOVAT");
    const row = await db.foreignCurrencyVatDesignation.findFirstOrThrow();
    expect(row).toMatchObject({ entity: "welld_ch", vatCode: "NOVAT", vatLabel: "Senza IVA", vatRateBasisPoints: 0, createdByEmail: "admin@welld.ch" });
    expect(getSettingDescriptor("accounting.welld_ch.foreign-currency-vat-code")).toBeUndefined();
  });

  it("(AC-4.4) refuses a deactivated or unknown code with 422 and writes no row", async () => {
    fake.setVatCodeActive("NOVAT", false);
    const inactive = await putDesignation("NOVAT");
    expect([inactive.status, inactive.body["code"]]).toEqual([422, "vat_code_inactive"]);
    const unknown = await putDesignation("NOPE");
    expect([unknown.status, unknown.body["code"]]).toEqual([422, "vat_code_not_found"]);
    expect((await putDesignation("5901")).body["code"]).toBe("vat_code_not_found");
    expect(await db.foreignCurrencyVatDesignation.count()).toBe(0);
  });

  it("(AC-4.5, AC-1.10) a designated code later deactivated is shown but not usable, and usable again after reactivation", async () => {
    await putDesignation("NOVAT");
    fake.setVatCodeActive("NOVAT", false);
    const off = await getDefaults();
    expect(off.body["foreignCurrencyVatCode"]).toMatchObject({ code: "NOVAT", state: "deactivated" });
    expect(off.body["foreignCurrencyVatCodeUsable"]).toBe(false);
    fake.setVatCodeActive("NOVAT", true);
    const on = await getDefaults();
    expect(on.body["foreignCurrencyVatCode"]).toMatchObject({ code: "NOVAT", state: "active" });
    expect(on.body["foreignCurrencyVatCodeUsable"]).toBe(true);
    expect(await db.foreignCurrencyVatDesignation.count()).toBe(1);
  });

  it("clearing records an all-null designation, which is not usable; clearing nothing is a no-op", async () => {
    expect((await putDesignation(null)).status).toBe(200);
    expect(await db.foreignCurrencyVatDesignation.count()).toBe(0);
    await putDesignation("NOVAT");
    const cleared = await putDesignation(null);
    expect(cleared.body["foreignCurrencyVatCode"]).toBeNull();
    expect(cleared.body["foreignCurrencyVatCodeUsable"]).toBe(false);
    expect((cleared.body["foreignCurrencyVatCodeHistory"] as any[]).map((h) => h.vatCode?.code ?? null)).toEqual(["NOVAT", null]);
  });

  it("suppresses a no-op designation", async () => {
    await putDesignation("NOVAT");
    await putDesignation("NOVAT");
    expect(await db.foreignCurrencyVatDesignation.count()).toBe(1);
  });
});

describe("(AC-6.9) Accounting unreachable", () => {
  for (const kind of ACCOUNTING_FAILURE_KINDS) {
    it(`${kind}: GET is 200 with the recorded copies, state unverified and accounting "unavailable"; PUT is 503 with Retry-After and writes nothing`, async () => {
      await putType("travel_train", "5901", "IMP81");
      await putDesignation("NOVAT");
      const rows = [await db.expenseTypeAccountingDefault.count(), await db.foreignCurrencyVatDesignation.count()];
      fake.failWith(kind);

      const view = await getDefaults();
      expect(view.status).toBe(200);
      expect(view.body["accounting"]).toBe("unavailable");
      expect(typeRow(view, "travel_train")).toMatchObject({
        account: { number: "5901", name: "Treno", state: "unverified" },
        vatCode: { code: "IMP81", label: "IVA 8.1%", ratePercent: "8.1", state: "unverified" },
      });
      expect(typeRow(view, "postal")).toMatchObject({ account: null, vatCode: null });
      expect(view.body["foreignCurrencyVatCode"]).toMatchObject({ code: "NOVAT", state: "unverified" });
      expect(view.body["foreignCurrencyVatCodeUsable"]).toBe(false);

      for (const res of [await putType("postal", "5901", null), await putType("postal", null, null), await putDesignation("EXPORT"), await putDesignation(null)]) {
        expect(res.status).toBe(503);
        expect(res.body["code"]).toBe("accounting_unavailable");
        expect(res.headers.get("Retry-After")).toBe("30");
        expectClean(res.body);
      }
      expect([await db.expenseTypeAccountingDefault.count(), await db.foreignCurrencyVatDesignation.count()]).toEqual(rows);
    });
  }

  it("back to reachable, the same save works", async () => {
    fake.failWith("network");
    expect((await putType("postal", "5901", null)).status).toBe(503);
    fake.failWith(null);
    expect((await putType("postal", "5901", null)).status).toBe(200);
  });
});

describe("(AC-4.8) no cache: every operation reads afresh", () => {
  it("two consecutive reads see a change made between them, and the fake counts two reads", async () => {
    await putType("postal", "5901", null);
    fake.resetCalls();
    expect(typeRow(await getDefaults(), "postal").account.state).toBe("active");
    fake.setAccountActive("5901", false);
    expect(typeRow(await getDefaults(), "postal").account.state).toBe("deactivated");
    expect(fake.reads).toEqual({ referenceData: 2, rates: 0, total: 2 });
  });

  it("one PUT reads once, and never reads rates", async () => {
    fake.resetCalls();
    await putType("postal", "5901", "IMP81");
    expect(fake.reads).toEqual({ referenceData: 1, rates: 0, total: 1 });
  });
});

describe("capability gates (AC-3.7, AC-2.8 of 20261118)", () => {
  it("no token is 401", async () => {
    expect((await getDefaults({ token: false })).status).toBe(401);
    expect((await putDesignation(null, { token: false })).status).toBe(401);
    expect((await putType("postal", null, null, { token: false })).status).toBe(401);
  });

  it("GET needs settings:read, and manage alone is not enough", async () => {
    for (const as of [NONE, MANAGE]) expect((await getDefaults({ as })).status).toBe(403);
    expect((await getDefaults({ as: READ })).status).toBe(200);
  });

  it("both PUTs need settings:manage, checked before the body, and before Accounting is read", async () => {
    fake.resetCalls();
    for (const as of [NONE, READ]) {
      expect((await putType("postal", "5901", null, { as })).status).toBe(403);
      expect((await call("PUT", "/accounting/expense-type-defaults/postal", { as, body: {} })).status).toBe(403);
      expect((await putDesignation(null, { as })).status).toBe(403);
      expect((await call("PUT", "/accounting/foreign-currency-vat-code", { as, body: {} })).status).toBe(403);
    }
    expect(await db.expenseTypeAccountingDefault.count()).toBe(0);
    expect(fake.reads.total).toBe(0);
  });

  it("(AC-3.7) an Accounting manager without settings:manage is refused on both PUTs, and cannot read the settings either", async () => {
    expect((await putType("postal", "5901", null, { as: ACCOUNTING_MANAGER })).status).toBe(403);
    expect((await putDesignation("NOVAT", { as: ACCOUNTING_MANAGER })).status).toBe(403);
    expect((await getDefaults({ as: ACCOUNTING_MANAGER })).status).toBe(403);
    expect(await db.expenseTypeAccountingDefault.count()).toBe(0);
    expect(await db.foreignCurrencyVatDesignation.count()).toBe(0);
  });

  it("(AC-4.4) a settings:manage holder with no Accounting grant can choose from Accounting's active entries", async () => {
    expect((await putType("postal", "5901", "IMP81", { as: MANAGE })).status).toBe(200);
  });
});

describe("loadRecordedDefaults (what approval, release, the view and the export resolve against)", () => {
  it("returns each type's latest recorded copy and the designation, as recorded", async () => {
    await putType("travel_train", "5901", "IMP81");
    await putType("travel_train", "6101", "IMP81");
    await putType("postal", "5901", null);
    await putDesignation("NOVAT");
    fake.setAccountActive("6101", false); // state is not the repo's business: the copy comes back as recorded

    const recorded = await db.$transaction((tx) => loadRecordedDefaults(tx));
    expect(recorded.defaults.travel_train).toEqual({ account: { number: "6101", name: "Ufficio" }, vatCode: { code: "IMP81", label: "IVA 8.1%", rateBasisPoints: 810 } });
    expect(recorded.defaults.postal).toEqual({ account: { number: "5901", name: "Treno" }, vatCode: null });
    expect(recorded.defaults.telephone).toBeUndefined();
    expect(recorded.foreignCurrencyVatCode).toEqual({ code: "NOVAT", label: "Senza IVA", rateBasisPoints: 0 });
  });

  it("is empty before anything is configured, and a cleared designation is none", async () => {
    expect(await loadRecordedDefaults()).toEqual({ defaults: {}, foreignCurrencyVatCode: null });
    await putDesignation("NOVAT");
    await putDesignation(null);
    expect((await loadRecordedDefaults()).foreignCurrencyVatCode).toBeNull();
  });
});
