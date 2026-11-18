/**
 * Integration tests for the defaults endpoints (T7, specs/20261118-refund-
 * accounting-export, plan § API contracts "Defaults").
 *
 * AC coverage: 1.9 / 1.10 (a deactivated entry is refused, and accepted again
 * after reactivation), 2.1 (history with actor and time), 2.2 (twelve rows, null
 * where unset), 2.4 (only active), 2.5 (designation history, immutability), 2.6
 * (inactive or unknown refused), 2.7 (inactive designation is not usable), 2.8
 * (capability gates).
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

const { defaultsRouter } = await import("./defaults.routes");
const { loadDefaultsSnapshot, EXPENSE_TYPES, FOREIGN_CURRENCY_VAT_CODE_KEY } = await import("./defaults.repo");
const { EXPENSE_TYPE_VALUES } = await import("./defaults.schemas");
const { setLedgerAccountActive, setVatCodeActive } = await import("./catalog.repo");
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
  return { status: res.status, body };
}

const by = { createdByUserId: "admin", createdByEmail: "admin@welld.ch" };
const mkAccount = (number: string) => db.ledgerAccount.create({ data: { entity: "welld_ch", number, name: `Account ${number}`, ...by } });
const mkVat = (code: string, bp = 810) => db.vatCode.create({ data: { entity: "welld_ch", code, label: `VAT ${code}`, rateBasisPoints: bp, ...by } });
const actor = { userId: "admin-1", email: "admin@welld.ch" };

const putType = (type: string, ledgerAccountId: string | null, vatCodeId: string | null, extra: Parameters<typeof call>[2] = {}) =>
  call("PUT", `/accounting/expense-type-defaults/${type}`, { body: { ledgerAccountId, vatCodeId }, ...extra });
const putDesignation = (vatCodeId: string | null, extra: Parameters<typeof call>[2] = {}) =>
  call("PUT", "/accounting/foreign-currency-vat-code", { body: { vatCodeId }, ...extra });
const getDefaults = (extra: Parameters<typeof call>[2] = {}) => call("GET", "/accounting/expense-type-defaults", extra);

beforeEach(async () => {
  await truncateRefundTables({ released: false });
  __resetAuthzCacheForTests();
});
afterAll(async () => {
  await truncateRefundTables({ released: false });
});

describe("GET (AC-2.2)", () => {
  it("always returns the twelve types in enum order, null where unset, with no designation", async () => {
    const res = await getDefaults();
    expect(res.status).toBe(200);
    expect(res.body["entity"]).toBe("welld_ch");
    const types = res.body["types"] as any[];
    expect(types.map((t) => t.type)).toEqual([...EXPENSE_TYPES]);
    expect(types).toHaveLength(12);
    for (const row of types) {
      expect(row).toMatchObject({ account: null, vatCode: null, updatedAt: null, updatedByEmail: null, history: [] });
    }
    expect(res.body["foreignCurrencyVatCode"]).toBeNull();
    expect(res.body["foreignCurrencyVatCodeUsable"]).toBe(false);
    expect(res.body["foreignCurrencyVatCodeHistory"]).toEqual([]);
  });

  it("the schema's type list is the Prisma enum, in the same order", () => {
    expect([...EXPENSE_TYPE_VALUES]).toEqual([...EXPENSE_TYPES]);
  });
});

describe("PUT a type default (AC-2.1, AC-2.4)", () => {
  it("saves both halves, shows them with who and when, and keeps every change in the history", async () => {
    const a1 = await mkAccount("5901");
    const a2 = await mkAccount("5904");
    const v1 = await mkVat("IMP81");
    const first = await putType("travel_train", a1.id, v1.id, { email: "one@welld.ch" });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      type: "travel_train",
      account: { id: a1.id, number: "5901", active: true },
      vatCode: { id: v1.id, code: "IMP81", ratePercent: "8.1", active: true },
      updatedByEmail: "one@welld.ch",
    });
    const second = await putType("travel_train", a2.id, null, { email: "two@welld.ch" });
    expect(second.body["account"]).toMatchObject({ number: "5904" });
    expect(second.body["vatCode"]).toBeNull();
    const history = second.body["history"] as any[];
    expect(history.map((h) => [h.account?.number ?? null, h.vatCode?.code ?? null, h.byEmail])).toEqual([
      ["5901", "IMP81", "one@welld.ch"],
      ["5904", null, "two@welld.ch"],
    ]);
    const times = history.map((h) => Date.parse(h.at));
    expect(times[1]).toBeGreaterThan(times[0]!);

    const view = await getDefaults();
    expect((view.body["types"] as any[]).find((t) => t.type === "travel_train").history).toHaveLength(2);
    expect((view.body["types"] as any[]).filter((t) => t.account !== null)).toHaveLength(1);
  });

  it("takes the actor from the JWT and never from the body", async () => {
    const a = await mkAccount("5901");
    await call("PUT", "/accounting/expense-type-defaults/postal", {
      body: { ledgerAccountId: a.id, vatCodeId: null, createdByEmail: "attacker@x.ch", createdByUserId: "x" },
      sub: "admin-9",
      email: "real@welld.ch",
    });
    const row = await db.expenseTypeDefault.findFirstOrThrow();
    expect(row).toMatchObject({ createdByUserId: "admin-9", createdByEmail: "real@welld.ch", entity: "welld_ch", type: "postal" });
  });

  it("clears a half with null (a row, not a no-op), and the other half stays", async () => {
    const a = await mkAccount("5901");
    const v = await mkVat("IMP81");
    await putType("postal", a.id, v.id);
    const cleared = await putType("postal", a.id, null);
    expect(cleared.body["vatCode"]).toBeNull();
    expect(cleared.body["account"]).toMatchObject({ number: "5901" });
    expect(await db.expenseTypeDefault.count()).toBe(2);
  });

  it("suppresses a no-op: the same values again, and null/null on a type never set, write no row", async () => {
    const a = await mkAccount("5901");
    await putType("postal", a.id, null);
    const again = await putType("postal", a.id, null);
    expect(again.status).toBe(200);
    expect((again.body["history"] as unknown[]).length).toBe(1);
    expect((await putType("telephone", null, null)).status).toBe(200);
    expect(await db.expenseTypeDefault.count()).toBe(1);
  });

  it("concurrent identical saves write one row", async () => {
    const a = await mkAccount("5901");
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => putType("postal", a.id, null)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await db.expenseTypeDefault.count()).toBe(1);
  });

  it("(AC-2.4) refuses an inactive account or VAT code with 422, naming which, and writes nothing", async () => {
    const a = await mkAccount("5901");
    const v = await mkVat("IMP81");
    await setLedgerAccountActive(a.id, false, actor);
    await setVatCodeActive(v.id, false, actor);
    const okA = await mkAccount("5904");
    const okV = await mkVat("IMP77", 770);
    const badAccount = await putType("postal", a.id, okV.id);
    expect(badAccount.status).toBe(422);
    expect(badAccount.body["code"]).toBe("ledger_account_inactive");
    expect(badAccount.body["detail"]).toContain("5901");
    const badVat = await putType("postal", okA.id, v.id);
    expect(badVat.status).toBe(422);
    expect(badVat.body["code"]).toBe("vat_code_inactive");
    expect(await db.expenseTypeDefault.count()).toBe(0);
  });

  it("refuses an unknown id with 422 unknown_*, including an id of the other catalog", async () => {
    const a = await mkAccount("5901");
    const v = await mkVat("IMP81");
    const unknownAccount = await putType("postal", "nope", null);
    expect(unknownAccount.body["code"]).toBe("unknown_ledger_account");
    expect((await putType("postal", v.id, null)).body["code"]).toBe("unknown_ledger_account");
    expect((await putType("postal", null, "nope")).body["code"]).toBe("unknown_vat_code");
    expect((await putType("postal", null, a.id)).body["code"]).toBe("unknown_vat_code");
    expect((await putType("postal", "nope", null)).status).toBe(422);
    expect(await db.expenseTypeDefault.count()).toBe(0);
  });

  it("(AC-1.9, AC-1.10) a reactivated entry can be chosen again", async () => {
    const a = await mkAccount("5901");
    const v = await mkVat("IMP81");
    await setLedgerAccountActive(a.id, false, actor);
    await setVatCodeActive(v.id, false, actor);
    expect((await putType("postal", a.id, v.id)).status).toBe(422);
    await setLedgerAccountActive(a.id, true, actor);
    await setVatCodeActive(v.id, true, actor);
    expect((await putType("postal", a.id, v.id)).status).toBe(200);
  });

  it("an entry deactivated AFTER it became the default stays recorded and is shown with active:false", async () => {
    const a = await mkAccount("5901");
    await putType("postal", a.id, null);
    await setLedgerAccountActive(a.id, false, actor);
    const view = await getDefaults();
    expect((view.body["types"] as any[]).find((t) => t.type === "postal").account).toMatchObject({ number: "5901", active: false });
    // saving the same, now inactive, value is refused rather than treated as a no-op
    expect((await putType("postal", a.id, null)).status).toBe(422);
  });

  it("is a 404 for something that is not an expense type, and 422 for a missing key or an empty id", async () => {
    expect((await putType("not_a_type", null, null)).status).toBe(404);
    expect((await call("PUT", "/accounting/expense-type-defaults/postal", { body: { ledgerAccountId: null } })).status).toBe(422);
    expect((await call("PUT", "/accounting/expense-type-defaults/postal", { body: { ledgerAccountId: "", vatCodeId: null } })).status).toBe(422);
    expect((await call("PUT", "/accounting/expense-type-defaults/postal", { body: {} })).status).toBe(422);
  });

  it("rows are immutable at the database (AC-2.1)", async () => {
    const a = await mkAccount("5901");
    await putType("postal", a.id, null);
    await expect(Promise.resolve(db.$executeRawUnsafe(`UPDATE "expense_type_default" SET "vatCodeId" = NULL`))).rejects.toThrow();
    await expect(Promise.resolve(db.$executeRawUnsafe(`DELETE FROM "expense_type_default"`))).rejects.toThrow();
  });
});

describe("the foreign-currency VAT code (AC-2.5 to AC-2.8)", () => {
  it("(AC-2.5) designates, shows the code, and keeps every designation in the history with actor and time", async () => {
    const v1 = await mkVat("NOVAT", 0);
    const v2 = await mkVat("EXPORT", 0);
    const first = await putDesignation(v1.id, { email: "one@welld.ch" });
    expect(first.status).toBe(200);
    expect(first.body["foreignCurrencyVatCode"]).toMatchObject({ id: v1.id, code: "NOVAT", ratePercent: "0", active: true });
    expect(first.body["foreignCurrencyVatCodeUsable"]).toBe(true);
    const second = await putDesignation(v2.id, { email: "two@welld.ch" });
    const history = second.body["foreignCurrencyVatCodeHistory"] as any[];
    expect(history.map((h) => [h.vatCode.code, h.byEmail])).toEqual([["NOVAT", "one@welld.ch"], ["EXPORT", "two@welld.ch"]]);
    expect(Date.parse(history[1].at)).toBeGreaterThan(Date.parse(history[0].at));
    const view = await getDefaults();
    expect(view.body["foreignCurrencyVatCode"]).toMatchObject({ code: "EXPORT" });
    expect(view.body["foreignCurrencyVatCodeHistory"]).toHaveLength(2);
  });

  it("(AC-2.5) is stored as an ordinary refund_setting row that the database never lets change", async () => {
    const v = await mkVat("NOVAT", 0);
    await putDesignation(v.id);
    const row = await db.refundSetting.findFirstOrThrow({ where: { key: FOREIGN_CURRENCY_VAT_CODE_KEY } });
    expect(row).toMatchObject({ value: v.id, createdByEmail: "admin@welld.ch" });
    await expect(Promise.resolve(db.$executeRawUnsafe(`UPDATE "refund_setting" SET "value" = 'x' WHERE id = $1`, row.id))).rejects.toThrow();
  });

  it("(AC-2.5) has no second write path: the generic settings registry does not know the key", () => {
    expect(getSettingDescriptor(FOREIGN_CURRENCY_VAT_CODE_KEY)).toBeUndefined();
  });

  it("(AC-2.6) refuses an inactive or unknown code with 422 and writes no row", async () => {
    const v = await mkVat("NOVAT", 0);
    await setVatCodeActive(v.id, false, actor);
    const inactive = await putDesignation(v.id);
    expect(inactive.status).toBe(422);
    expect(inactive.body["code"]).toBe("vat_code_inactive");
    const unknown = await putDesignation("nope");
    expect(unknown.status).toBe(422);
    expect(unknown.body["code"]).toBe("unknown_vat_code");
    const account = await mkAccount("5901");
    expect((await putDesignation(account.id)).body["code"]).toBe("unknown_vat_code");
    expect(await db.refundSetting.count({ where: { key: FOREIGN_CURRENCY_VAT_CODE_KEY } })).toBe(0);
  });

  it("(AC-2.7, AC-1.10) a designated code later deactivated is still shown but not usable, and usable again after reactivation", async () => {
    const v = await mkVat("NOVAT", 0);
    await putDesignation(v.id);
    await setVatCodeActive(v.id, false, actor);
    const off = await getDefaults();
    expect(off.body["foreignCurrencyVatCode"]).toMatchObject({ code: "NOVAT", active: false });
    expect(off.body["foreignCurrencyVatCodeUsable"]).toBe(false);
    await setVatCodeActive(v.id, true, actor);
    const on = await getDefaults();
    expect(on.body["foreignCurrencyVatCode"]).toMatchObject({ code: "NOVAT", active: true });
    expect(on.body["foreignCurrencyVatCodeUsable"]).toBe(true);
    expect(await db.refundSetting.count({ where: { key: FOREIGN_CURRENCY_VAT_CODE_KEY } })).toBe(1);
  });

  it("clearing records a null designation, which is not usable; clearing nothing is a no-op", async () => {
    expect((await putDesignation(null)).status).toBe(200);
    expect(await db.refundSetting.count()).toBe(0);
    const v = await mkVat("NOVAT", 0);
    await putDesignation(v.id);
    const cleared = await putDesignation(null);
    expect(cleared.body["foreignCurrencyVatCode"]).toBeNull();
    expect(cleared.body["foreignCurrencyVatCodeUsable"]).toBe(false);
    expect((cleared.body["foreignCurrencyVatCodeHistory"] as any[]).map((h) => h.vatCode?.code ?? null)).toEqual(["NOVAT", null]);
  });

  it("suppresses a no-op designation", async () => {
    const v = await mkVat("NOVAT", 0);
    await putDesignation(v.id);
    await putDesignation(v.id);
    expect(await db.refundSetting.count({ where: { key: FOREIGN_CURRENCY_VAT_CODE_KEY } })).toBe(1);
  });
});

describe("(AC-2.8) capability gates", () => {
  it("no token is 401", async () => {
    expect((await getDefaults({ token: false })).status).toBe(401);
    expect((await putDesignation(null, { token: false })).status).toBe(401);
    expect((await putType("postal", null, null, { token: false })).status).toBe(401);
  });

  it("GET needs settings:read, and manage alone is not enough", async () => {
    for (const as of [NONE, MANAGE]) expect((await getDefaults({ as })).status).toBe(403);
    expect((await getDefaults({ as: READ })).status).toBe(200);
  });

  it("both PUTs need settings:manage, checked before the body", async () => {
    const a = await mkAccount("5901");
    for (const as of [NONE, READ]) {
      expect((await putType("postal", a.id, null, { as })).status).toBe(403);
      expect((await call("PUT", "/accounting/expense-type-defaults/postal", { as, body: {} })).status).toBe(403);
      expect((await putDesignation(null, { as })).status).toBe(403);
      expect((await call("PUT", "/accounting/foreign-currency-vat-code", { as, body: {} })).status).toBe(403);
    }
    expect(await db.expenseTypeDefault.count()).toBe(0);
  });
});

describe("loadDefaultsSnapshot (what approval, release, view and export resolve against)", () => {
  it("returns each type's current defaults and the designation, with the current active flags", async () => {
    const a = await mkAccount("5901");
    const b = await mkAccount("6101");
    const v = await mkVat("IMP81");
    const z = await mkVat("NOVAT", 0);
    await putType("travel_train", a.id, v.id);
    await putType("travel_train", b.id, v.id);
    await putType("postal", a.id, null);
    await putDesignation(z.id);
    await setLedgerAccountActive(b.id, false, actor);

    const snapshot = await db.$transaction((tx) => loadDefaultsSnapshot(tx));
    expect(snapshot.defaults.travel_train).toMatchObject({ account: { number: "6101", active: false }, vatCode: { code: "IMP81", active: true } });
    expect(snapshot.defaults.postal).toMatchObject({ account: { number: "5901", active: true }, vatCode: null });
    expect(snapshot.defaults.telephone).toBeUndefined();
    expect(snapshot.foreignCurrencyVatCode).toMatchObject({ code: "NOVAT", rateBasisPoints: 0, active: true });
  });

  it("is empty before anything is configured", async () => {
    expect(await loadDefaultsSnapshot()).toEqual({ defaults: {}, foreignCurrencyVatCode: null });
  });

  it("returns an inactive designation as is, with active:false", async () => {
    const z = await mkVat("NOVAT", 0);
    await putDesignation(z.id);
    await setVatCodeActive(z.id, false, actor);
    expect((await loadDefaultsSnapshot()).foreignCurrencyVatCode).toMatchObject({ code: "NOVAT", active: false });
  });
});
