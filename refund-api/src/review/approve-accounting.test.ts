/**
 * What approving a request does for accounting (T12, specs/20261118-refund-
 * accounting-export): the release gate, the classification check and freeze,
 * the receipt numbers, the two new 409 codes.
 *
 * Real Postgres, jwt/authz mocked (`test-support/testAuth.ts`), the router under
 * test is `decideRouter`. The plan's rows covered here:
 *   AC-2.3  a frozen classification ignores later changes of the defaults
 *   AC-3.4  `classification_missing`: nothing changes, no number is consumed
 *           (incl. an inactive default account, an unset or inactive
 *           foreign-currency VAT code with a CHF line of the same type approving)
 *   AC-3.5  the freeze records cause `approval`; defaults changed afterwards do not move it
 *   AC-3.9  an IT-only request approves with no defaults; IT lines are never classified
 *   AC-4.1  every non-rejected line is numbered, WellD Italia lines too
 *   AC-4.2  initials, year, three digits
 *   AC-4.3  contiguous per employee and year; a refused approval consumes nothing
 *   AC-4.4  numbered by expense date, then createdAt, then id
 *   AC-4.5  two years in one request are two sequences
 *   AC-4.6  two employees with the same initials each start at 001
 *   AC-4.10 parallel approvals of one employee: distinct, contiguous (20 rounds)
 *   D6      `accounting_release_pending` until the marker exists
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { ResolveResponse } from "../authz/resolveClient";
import { markAccountingReleased } from "../test-support/accountingRelease";
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

const harness = setupTestAuth();
await harness.init();

// A query string makes this a module instance of its own: `decide.routes.test.ts` imports the same file, and a router
// created there is bound to THAT file's mocked jwt/authz (testAuth.ts, "no shared router specifier").
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { decideRouter } = (await import("./decide.routes?approve-accounting")) as typeof import("./decide.routes");
const { db } = await import("../lib/db");
const { FOREIGN_CURRENCY_VAT_CODE_KEY } = await import("../accounting/legacyFk");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { notifyTransport } = await import("../lib/notifyPost");

// The decision notification and email go to notify-api: answered here, never sent. The service-token provider
// is disabled under NODE_ENV=test, so a stub stands in for it and the push reaches the (faked) wire quietly.
const realTokens = notifyTransport.tokens;
notifyTransport.tokens = { async getToken() { return "stub-service-jwt"; }, invalidate() {} };
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (typeof url === "string" && url.includes("/system/")) return new Response(JSON.stringify({ id: "n1" }), { status: 200 });
  return originalFetch(url, init);
}) as unknown as typeof fetch;

const accountingPerms: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [
    { resource: "refund", action: "access", conditions: null },
    { resource: "request", action: "review", conditions: null },
    { resource: "request", action: "set-approved-total", conditions: null },
    { resource: "request", action: "approve", conditions: null },
    { resource: "request", action: "reject", conditions: null },
  ],
  entity: null,
  jobTitle: null,
};

const by = { createdByUserId: "admin", createdByEmail: "admin@welld.ch" };
const ACTOR_SUB = "acct-1";

let accountTrain: { id: string };
let accountOffice: { id: string };
let imp81: { id: string };
let novat: { id: string };

async function seedCatalog() {
  accountTrain = await db.ledgerAccount.create({ data: { entity: "welld_ch", number: "5901", name: "Treno", ...by } });
  accountOffice = await db.ledgerAccount.create({ data: { entity: "welld_ch", number: "6101", name: "Ufficio", ...by } });
  imp81 = await db.vatCode.create({ data: { entity: "welld_ch", code: "IMP81", label: "IVA 8.1%", rateBasisPoints: 810, ...by } });
  novat = await db.vatCode.create({ data: { entity: "welld_ch", code: "NOVAT", label: "Senza IVA", rateBasisPoints: 0, ...by } });
  // `stationery` deliberately has no default.
  await db.expenseTypeDefault.create({ data: { entity: "welld_ch", type: "travel_train", ledgerAccountId: accountTrain.id, vatCodeId: imp81.id, ...by } });
  await db.expenseTypeDefault.create({ data: { entity: "welld_ch", type: "office_material", ledgerAccountId: accountOffice.id, vatCodeId: imp81.id, ...by } });
  await db.expenseTypeDefault.create({ data: { entity: "welld_ch", type: "postal", ledgerAccountId: accountOffice.id, vatCodeId: novat.id, ...by } });
  await db.refundSetting.create({ data: { key: "accounting.welld_ch.foreign-currency-vat-code", value: novat.id, ...by } });
}

beforeEach(async () => {
  await truncateRefundTables();
  __resetAuthzCacheForTests();
  harness.setResolve(async () => accountingPerms);
  await seedCatalog();
});
afterAll(async () => {
  await truncateRefundTables();
  notifyTransport.tokens = realTokens;
  globalThis.fetch = originalFetch;
});

interface LineSpec {
  date?: string;
  type?: "travel_train" | "office_material" | "postal" | "stationery" | "representation_gifts";
  entity?: "welld_ch" | "welld_it";
  currency?: "CHF" | "EUR" | "USD" | "GBP";
  rejected?: boolean;
  createdAt?: string;
  id?: string;
  approvedTotalCents?: number | null;
  requestedAmountCents?: number;
}

async function createRequest(owner: { id: string; name?: string | null; email?: string }, lines: LineSpec[]) {
  const request = await db.refundRequest.create({
    data: {
      ownerUserId: owner.id,
      ownerEmail: owner.email ?? `${owner.id}@welld.ch`,
      ownerName: owner.name === undefined ? "Matteo Codogno" : owner.name,
      status: "submitted",
      submittedAt: new Date(),
    },
  });
  const ids: string[] = [];
  for (const spec of lines) {
    const line = await db.refundLine.create({
      data: {
        ...(spec.id ? { id: spec.id } : {}),
        requestId: request.id,
        date: new Date(spec.date ?? "2026-03-02"),
        type: spec.type ?? "travel_train",
        motivo: "m",
        entity: spec.entity ?? "welld_ch",
        currency: spec.currency ?? "CHF",
        requestedAmountCents: spec.requestedAmountCents ?? 1000,
        approvedTotalCents: spec.approvedTotalCents === undefined ? null : spec.approvedTotalCents,
        ...(spec.createdAt ? { createdAt: new Date(spec.createdAt) } : {}),
        ...(spec.rejected ? { rejectionReason: "no", rejectedAt: new Date(), rejectedByUserId: "a", rejectedByEmail: "a@x", approvedTotalCents: 0 } : {}),
      },
    });
    ids.push(line.id);
  }
  return { id: request.id, lineIds: ids };
}

async function approve(requestId: string) {
  const token = await harness.signToken({ sub: ACTOR_SUB, email: "acct1@welld.ch" });
  const res = await decideRouter.request(`/review/requests/${requestId}/approve`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const lineOf = (id: string) => db.refundLine.findUniqueOrThrow({ where: { id } });
const numbersOf = async (ids: string[]) => Promise.all(ids.map(async (id) => (await lineOf(id)).receiptNumber));
const counterOf = (owner: string, year: number) =>
  db.receiptCounter.findUnique({ where: { ownerUserId_year: { ownerUserId: owner, year } } });

describe("the release gate (D6)", () => {
  it("409 accounting_release_pending before the marker, and nothing at all is written", async () => {
    await truncateRefundTables({ released: false });
    await seedCatalog();
    const r = await createRequest({ id: "owner-1" }, [{}, { entity: "welld_it" }]);

    const res = await approve(r.id);
    expect(res.status).toBe(409);
    expect(res.body["code"]).toBe("accounting_release_pending");

    const request = await db.refundRequest.findUniqueOrThrow({ where: { id: r.id } });
    expect(request.status).toBe("submitted");
    expect(request.decidedAt).toBeNull();
    expect(await db.refundAuditEntry.count()).toBe(0);
    expect(await db.receiptCounter.count()).toBe(0);
    for (const id of r.lineIds) {
      const line = await lineOf(id);
      expect(line.approvedTotalCents).toBeNull();
      expect(line.receiptNumber).toBeNull();
    }

    await markAccountingReleased();
    expect((await approve(r.id)).status).toBe(200);
    expect(await numbersOf(r.lineIds)).toEqual(["MC26/001", "MC26/002"]);
  });

  it("an IT-only request is refused by the gate too", async () => {
    await truncateRefundTables({ released: false });
    const r = await createRequest({ id: "owner-1" }, [{ entity: "welld_it", currency: "EUR" }]);
    const res = await approve(r.id);
    expect(res.status).toBe(409);
    expect(res.body["code"]).toBe("accounting_release_pending");
  });

  it("an already-decided request still answers the ordinary 409, not the gate", async () => {
    await truncateRefundTables({ released: false });
    const r = await createRequest({ id: "owner-1" }, [{}]);
    await db.refundRequest.update({ where: { id: r.id }, data: { status: "approved" } });
    const res = await approve(r.id);
    expect(res.status).toBe(409);
    expect(res.body["code"]).toBeUndefined();
  });
});

describe("approve: freeze and numbering", () => {
  it("(AC-3.1/3.5, AC-4.2) freezes the type defaults, numbers the line MC26/001 and audits cause approval", async () => {
    const r = await createRequest({ id: "owner-1" }, [{ type: "travel_train" }]);
    const res = await approve(r.id);
    expect(res.status).toBe(200);

    const line = await lineOf(r.lineIds[0]!);
    expect(line).toMatchObject({
      ledgerAccountId: accountTrain.id,
      ledgerAccountIsDefault: true,
      vatCodeId: imp81.id,
      vatCodeIsDefault: true,
      receiptNumber: "MC26/001",
      receiptOwnerUserId: "owner-1",
      receiptYear: 2026,
      receiptSeq: 1,
    });
    expect(line.numberedAt).not.toBeNull();

    const classified = await db.refundAuditEntry.findMany({ where: { requestId: r.id, action: "line_classified" } });
    expect(classified).toHaveLength(1);
    expect(classified[0]!.actorUserId).toBe(ACTOR_SUB);
    expect(classified[0]!.lineId).toBe(r.lineIds[0]!);
    expect((classified[0]!.detail as any).cause).toBe("approval");
    expect((classified[0]!.detail as any).account.to).toEqual({ id: accountTrain.id, number: "5901" });
    expect((classified[0]!.detail as any).vatCode.to.code).toBe("IMP81");
    const numbered = await db.refundAuditEntry.findMany({ where: { requestId: r.id, action: "receipt_number_assigned" } });
    expect(numbered).toHaveLength(1);
    expect(numbered[0]!.detail).toEqual({ cause: "approval", receiptNumber: "MC26/001", year: 2026, seq: 1 });
  });

  it("(AC-3.5) a manual override on the line is what gets frozen, as not-default", async () => {
    const r = await createRequest({ id: "owner-1" }, [{ type: "travel_train" }]);
    await db.refundLine.update({ where: { id: r.lineIds[0]! }, data: { ledgerAccountId: accountOffice.id, ledgerAccountIsDefault: false } });
    expect((await approve(r.id)).status).toBe(200);
    const line = await lineOf(r.lineIds[0]!);
    expect(line.ledgerAccountId).toBe(accountOffice.id);
    expect(line.ledgerAccountIsDefault).toBe(false);
    expect(line.vatCodeId).toBe(imp81.id);
    expect(line.vatCodeIsDefault).toBe(true);
  });

  it("(AC-3.2) a non-CHF line freezes the type's account and the foreign-currency VAT code", async () => {
    const r = await createRequest({ id: "owner-1" }, [{ type: "office_material", currency: "EUR" }]);
    expect((await approve(r.id)).status).toBe(200);
    const line = await lineOf(r.lineIds[0]!);
    expect(line.ledgerAccountId).toBe(accountOffice.id);
    expect(line.vatCodeId).toBe(novat.id);
    expect(line.vatCodeIsDefault).toBe(true);
  });

  it("(AC-3.5, AC-2.3) defaults changed after approval do not move the frozen line, and the designation neither", async () => {
    const r = await createRequest({ id: "owner-1" }, [{ type: "travel_train" }, { type: "office_material", currency: "EUR" }]);
    expect((await approve(r.id)).status).toBe(200);
    const before = await Promise.all(r.lineIds.map(lineOf));

    const actor = { userId: "admin", email: "admin@welld.ch" };
    const by = { createdByUserId: actor.userId, createdByEmail: actor.email };
    await db.expenseTypeDefault.create({ data: { entity: "welld_ch", type: "travel_train", ledgerAccountId: accountOffice.id, vatCodeId: novat.id, createdAt: new Date(Date.now() + 1000), ...by } });
    await db.expenseTypeDefault.create({ data: { entity: "welld_ch", type: "office_material", ledgerAccountId: accountTrain.id, vatCodeId: imp81.id, createdAt: new Date(Date.now() + 1000), ...by } });
    await db.refundSetting.create({ data: { key: FOREIGN_CURRENCY_VAT_CODE_KEY, value: imp81.id, createdAt: new Date(Date.now() + 1000), ...by } });
    await db.refundSetting.create({ data: { key: FOREIGN_CURRENCY_VAT_CODE_KEY, value: null, createdAt: new Date(Date.now() + 2000), ...by } });

    const after = await Promise.all(r.lineIds.map(lineOf));
    for (const [i, line] of after.entries()) {
      expect(line.ledgerAccountId).toBe(before[i]!.ledgerAccountId);
      expect(line.vatCodeId).toBe(before[i]!.vatCodeId);
      expect(line.ledgerAccountIsDefault).toBe(before[i]!.ledgerAccountIsDefault);
      expect(line.vatCodeIsDefault).toBe(before[i]!.vatCodeIsDefault);
    }
    expect(after[1]!.vatCodeId).toBe(novat.id);
  });

  it("(AC-4.1, AC-3.9) a rejected line is not numbered or classified; WellD Italia lines are numbered but never classified", async () => {
    const r = await createRequest({ id: "owner-1" }, [
      { date: "2026-03-01", type: "travel_train" },
      { date: "2026-03-02", rejected: true, type: "stationery" },
      { date: "2026-03-03", entity: "welld_it", currency: "EUR", type: "stationery" },
    ]);
    expect((await approve(r.id)).status).toBe(200);
    expect(await numbersOf(r.lineIds)).toEqual(["MC26/001", null, "MC26/002"]);

    const rejected = await lineOf(r.lineIds[1]!);
    expect(rejected.ledgerAccountId).toBeNull();
    expect(rejected.vatCodeId).toBeNull();
    expect(rejected.receiptOwnerUserId).toBeNull();
    const it = await lineOf(r.lineIds[2]!);
    expect(it.ledgerAccountId).toBeNull();
    expect(it.vatCodeId).toBeNull();
    expect(it.ledgerAccountIsDefault).toBeNull();
    expect(it.vatCodeIsDefault).toBeNull();

    const classifiedLineIds = (await db.refundAuditEntry.findMany({ where: { requestId: r.id, action: "line_classified" } })).map((a) => a.lineId);
    expect(classifiedLineIds).toEqual([r.lineIds[0]!]);
    expect(await db.refundAuditEntry.count({ where: { requestId: r.id, action: "receipt_number_assigned" } })).toBe(2);
    expect((await counterOf("owner-1", 2026))!.lastSeq).toBe(2);
  });

  it("(AC-3.9) an IT-only request approves with no defaults configured at all", async () => {
    await truncateRefundTables();
    const r = await createRequest({ id: "owner-1" }, [
      { entity: "welld_it", currency: "EUR", type: "stationery" },
      { entity: "welld_it", currency: "EUR", type: "representation_gifts" },
    ]);
    expect((await approve(r.id)).status).toBe(200);
    expect(await numbersOf(r.lineIds)).toEqual(["MC26/001", "MC26/002"]);
  });

  it("(AC-3.4) a rejected WellD CH line with no default does not block the approval", async () => {
    const r = await createRequest({ id: "owner-1" }, [{ type: "travel_train" }, { type: "stationery", rejected: true }]);
    expect((await approve(r.id)).status).toBe(200);
  });

  it("a line approved at 0 and not rejected is classified and numbered like any other", async () => {
    const r = await createRequest({ id: "owner-1" }, [{ approvedTotalCents: 0 }]);
    expect((await approve(r.id)).status).toBe(200);
    const line = await lineOf(r.lineIds[0]!);
    expect(line.approvedTotalCents).toBe(0);
    expect(line.receiptNumber).toBe("MC26/001");
    expect(line.vatCodeId).toBe(imp81.id);
  });

  it("AC-7.2 of the old spec still holds: untouched lines default to the requested amount", async () => {
    const r = await createRequest({ id: "owner-1" }, [{ requestedAmountCents: 4200 }, { approvedTotalCents: 300 }]);
    expect((await approve(r.id)).status).toBe(200);
    expect((await lineOf(r.lineIds[0]!)).approvedTotalCents).toBe(4200);
    expect((await lineOf(r.lineIds[1]!)).approvedTotalCents).toBe(300);
  });
});

describe("(AC-3.4) classification_missing", () => {
  async function expectNothingChanged(requestId: string, lineIds: string[]) {
    const request = await db.refundRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(request.status).toBe("submitted");
    expect(request.decidedAt).toBeNull();
    expect(request.decidedByUserId).toBeNull();
    expect(await db.refundAuditEntry.count()).toBe(0);
    expect(await db.receiptCounter.count()).toBe(0);
    for (const id of lineIds) {
      const line = await lineOf(id);
      expect(line.approvedTotalCents).toBeNull(); // the defaulting of untouched lines rolled back too
      expect(line.receiptNumber).toBeNull();
      expect(line.ledgerAccountId).toBeNull();
      expect(line.vatCodeId).toBeNull();
    }
  }

  it("a type without a default: 409 listing that line with id, date and type; nothing changes", async () => {
    const r = await createRequest({ id: "owner-1" }, [
      { date: "2026-03-01", type: "travel_train" },
      { date: "2026-03-05", type: "stationery" },
      { date: "2026-03-06", entity: "welld_it", currency: "EUR" },
    ]);
    const res = await approve(r.id);
    expect(res.status).toBe(409);
    expect(res.body["code"]).toBe("classification_missing");
    expect(res.body["status"]).toBe(409);
    expect(res.body["lines"]).toEqual([
      { lineId: r.lineIds[1]!, date: "2026-03-05", type: "stationery", missing: ["account", "vatCode"] },
    ]);
    await expectNothingChanged(r.id, r.lineIds);
  });

  it("lists every missing line, with only the missing halves", async () => {
    const r = await createRequest({ id: "owner-1" }, [
      { date: "2026-03-01", type: "stationery" },
      { date: "2026-03-02", type: "representation_gifts", currency: "EUR" },
    ]);
    // a half default: account only
    await db.expenseTypeDefault.create({ data: { entity: "welld_ch", type: "representation_gifts", ledgerAccountId: accountOffice.id, vatCodeId: null, ...by } });
    await db.refundSetting.create({ data: { key: "accounting.welld_ch.foreign-currency-vat-code", value: null, ...by } });
    const res = await approve(r.id);
    expect(res.status).toBe(409);
    expect(res.body["lines"]).toEqual([
      { lineId: r.lineIds[0]!, date: "2026-03-01", type: "stationery", missing: ["account", "vatCode"] },
      { lineId: r.lineIds[1]!, date: "2026-03-02", type: "representation_gifts", missing: ["vatCode"] },
    ]);
    await expectNothingChanged(r.id, r.lineIds);
  });

  it("a type whose default ACCOUNT was deactivated counts as missing (G3)", async () => {
    await db.accountingCatalogStatus.create({ data: { ledgerAccountId: accountTrain.id, active: false, ...by } });
    const r = await createRequest({ id: "owner-1" }, [{ type: "travel_train" }]);
    const res = await approve(r.id);
    expect(res.status).toBe(409);
    expect(res.body["lines"]).toEqual([{ lineId: r.lineIds[0]!, date: "2026-03-02", type: "travel_train", missing: ["account"] }]);
    await expectNothingChanged(r.id, r.lineIds);

    // reactivation brings the default back (AC-1.9): the same request then approves
    await db.accountingCatalogStatus.create({ data: { ledgerAccountId: accountTrain.id, active: true, ...by } });
    expect((await approve(r.id)).status).toBe(200);
  });

  it("an unset foreign-currency VAT code refuses a non-CHF line, while a CHF line of the same type approves", async () => {
    await db.refundSetting.create({ data: { key: "accounting.welld_ch.foreign-currency-vat-code", value: null, ...by } });
    const eur = await createRequest({ id: "owner-1" }, [{ type: "office_material", currency: "EUR" }]);
    const res = await approve(eur.id);
    expect(res.status).toBe(409);
    expect(res.body["lines"]).toEqual([{ lineId: eur.lineIds[0]!, date: "2026-03-02", type: "office_material", missing: ["vatCode"] }]);
    await expectNothingChanged(eur.id, eur.lineIds);

    const chf = await createRequest({ id: "owner-2" }, [{ type: "office_material", currency: "CHF" }]);
    expect((await approve(chf.id)).status).toBe(200);
  });

  it("an INACTIVE foreign-currency VAT code refuses a non-CHF line (AC-2.7), and reactivating it lets it through", async () => {
    await db.accountingCatalogStatus.create({ data: { vatCodeId: novat.id, active: false, ...by } });
    const r = await createRequest({ id: "owner-1" }, [{ type: "office_material", currency: "USD" }]);
    const res = await approve(r.id);
    expect(res.status).toBe(409);
    expect((res.body["lines"] as any[])[0].missing).toEqual(["vatCode"]);
    await db.accountingCatalogStatus.create({ data: { vatCodeId: novat.id, active: true, ...by } });
    expect((await approve(r.id)).status).toBe(200);
  });

  it("a refusal consumes no number (AC-4.3): the next approval of the same employee still starts at 001", async () => {
    const bad = await createRequest({ id: "owner-1" }, [{ date: "2026-03-01" }, { date: "2026-03-02", type: "stationery" }, { entity: "welld_it", currency: "EUR" }]);
    expect((await approve(bad.id)).status).toBe(409);
    expect(await db.receiptCounter.count()).toBe(0);

    const good = await createRequest({ id: "owner-1" }, [{ date: "2026-03-03" }]);
    expect((await approve(good.id)).status).toBe(200);
    expect(await numbersOf(good.lineIds)).toEqual(["MC26/001"]);
    expect((await counterOf("owner-1", 2026))!.lastSeq).toBe(1);
  });

  it("rejecting the unclassifiable line lets the rest approve", async () => {
    const r = await createRequest({ id: "owner-1" }, [{ type: "travel_train" }, { type: "stationery" }]);
    expect((await approve(r.id)).status).toBe(409);
    await db.refundLine.update({
      where: { id: r.lineIds[1]! },
      data: { rejectionReason: "no", rejectedAt: new Date(), rejectedByUserId: "a", rejectedByEmail: "a@x", approvedTotalCents: 0 },
    });
    expect((await approve(r.id)).status).toBe(200);
  });
});

describe("numbering through approve", () => {
  it("(AC-4.3) three successive approvals are 001..n and the counter equals the highest", async () => {
    const a = await createRequest({ id: "owner-1" }, [{ date: "2026-03-02" }, { date: "2026-03-03" }]);
    const b = await createRequest({ id: "owner-1" }, [{ date: "2026-03-01" }]);
    const c = await createRequest({ id: "owner-1" }, [{ date: "2026-04-01" }, { date: "2026-04-02" }]);
    for (const r of [a, b, c]) expect((await approve(r.id)).status).toBe(200);
    expect(await numbersOf(a.lineIds)).toEqual(["MC26/001", "MC26/002"]);
    expect(await numbersOf(b.lineIds)).toEqual(["MC26/003"]);
    expect(await numbersOf(c.lineIds)).toEqual(["MC26/004", "MC26/005"]);
    expect((await counterOf("owner-1", 2026))!.lastSeq).toBe(5);
  });

  it("(AC-4.4) lines created in the order 03-10, 03-02, 03-02' are numbered 03-02, 03-02', 03-10; equal createdAt falls to the id", async () => {
    const r = await createRequest({ id: "owner-1" }, [
      { date: "2026-03-10", id: "line-a" },
      { date: "2026-03-02", id: "line-b", createdAt: "2026-03-05T10:00:00Z" },
      { date: "2026-03-02", id: "line-c", createdAt: "2026-03-05T10:00:01Z" },
      { date: "2026-03-02", id: "line-0", createdAt: "2026-03-05T10:00:01Z" },
    ]);
    expect((await approve(r.id)).status).toBe(200);
    expect(await numbersOf(["line-b", "line-0", "line-c", "line-a"])).toEqual(["MC26/001", "MC26/002", "MC26/003", "MC26/004"]);
  });

  it("(AC-4.5) lines dated 2025-12-30 and 2026-01-02 are 25/001 and 26/001", async () => {
    const r = await createRequest({ id: "owner-1", name: "Xavier Yates" }, [{ date: "2026-01-02" }, { date: "2025-12-30" }]);
    expect((await approve(r.id)).status).toBe(200);
    expect(await numbersOf(r.lineIds)).toEqual(["XY26/001", "XY25/001"]);
    expect((await counterOf("owner-1", 2025))!.lastSeq).toBe(1);
    expect((await counterOf("owner-1", 2026))!.lastSeq).toBe(1);
  });

  it("(AC-4.6) two employees with the same initials each start at 001", async () => {
    const a = await createRequest({ id: "owner-1", name: "Matteo Codogno" }, [{}]);
    const b = await createRequest({ id: "owner-2", name: "Marta Conti" }, [{}]);
    expect((await approve(a.id)).status).toBe(200);
    expect((await approve(b.id)).status).toBe(200);
    expect(await numbersOf([...a.lineIds, ...b.lineIds])).toEqual(["MC26/001", "MC26/001"]);
  });

  it("(AC-4.2/4.8) a missing display name falls back to the e-mail for the initials", async () => {
    const r = await createRequest({ id: "owner-1", name: null, email: "anna.rossi@welld.ch" }, [{}]);
    expect((await approve(r.id)).status).toBe(200);
    expect(await numbersOf(r.lineIds)).toEqual(["AR26/001"]);
  });

  it("(AC-4.10) two parallel approvals of the same employee: distinct, contiguous numbers, 20 rounds", async () => {
    for (let round = 0; round < 20; round++) {
      const owner = { id: `owner-p${round}` };
      const a = await createRequest(owner, [{ date: "2026-03-02" }, { date: "2026-03-03" }, { date: "2025-12-31" }]);
      const b = await createRequest(owner, [{ date: "2026-03-01" }, { date: "2026-03-04" }]);
      const [ra, rb] = await Promise.all([approve(a.id), approve(b.id)]);
      expect([ra.status, rb.status]).toEqual([200, 200]);
      const all = (await numbersOf([...a.lineIds, ...b.lineIds])) as string[];
      expect(new Set(all).size).toBe(5);
      const seq2026 = all.filter((n) => n.startsWith("MC26/")).map((n) => Number(n.slice(5))).sort((x, y) => x - y);
      expect(seq2026).toEqual([1, 2, 3, 4]);
      expect(all.filter((n) => n.startsWith("MC25/"))).toEqual(["MC25/001"]);
      expect((await counterOf(owner.id, 2026))!.lastSeq).toBe(4);
      expect((await counterOf(owner.id, 2025))!.lastSeq).toBe(1);
    }
  });

  it("two approvals of the SAME request: one wins, the number is issued once", async () => {
    for (let round = 0; round < 5; round++) {
      const r = await createRequest({ id: `owner-s${round}` }, [{ date: "2026-03-02" }, { date: "2026-03-03" }]);
      const results = await Promise.all([approve(r.id), approve(r.id)]);
      expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
      expect(await numbersOf(r.lineIds)).toEqual(["MC26/001", "MC26/002"]);
      expect((await counterOf(`owner-s${round}`, 2026))!.lastSeq).toBe(2);
      expect(await db.refundAuditEntry.count({ where: { requestId: r.id, action: "receipt_number_assigned" } })).toBe(2);
    }
  });
});
