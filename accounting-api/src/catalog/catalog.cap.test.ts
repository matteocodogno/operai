/**
 * The cap on the entries of an entity (security-review F-01, specs/20261119-accounting; AC-1.1, AC-1.3, AC-1.5, AC-1.6,
 * AC-6.1): a create beyond `CATALOG_CAPS` is a 409 `catalog_full` and writes nothing. The cap counts every entry of the entity,
 * deactivated ones included, because the reference-data answer to Refund holds them too and nothing is ever deleted.
 *
 * The size the cap allows is asserted against refund-api's body limit in `../catalog.cap.cross-package.test.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { fakeResolve, PERSONAS } from "../test-support/fakeResolve";
import { truncateAccountingTables } from "../test-support/dbCleanup";
import { setupTestAuth } from "../test-support/testAuth";

const harness = setupTestAuth();
await harness.init();

const { app } = await import("../index");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../authz/authz.middleware");
const { CATALOG_CAPS } = await import("./limits");

const ACCOUNTS = "/v1/entities/welld_ch/ledger-accounts";
const VATS = "/v1/entities/welld_ch/vat-codes";
const SEED_ACTOR = { createdByUserId: "user-seed", createdByEmail: "seed@welld.ch" } as const;

async function call(method: "POST" | "GET", path: string, body?: unknown, persona: (typeof PERSONAS)[keyof typeof PERSONAS] = PERSONAS.accountingCh) {
  __resetAuthzCacheForTests();
  harness.setResolve(fakeResolve(persona));
  const token = await harness.signToken({ sub: persona.sub, email: `${persona.sub}@welld.ch` });
  const res = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

const numberOf = (i: number): string => String(100_000 + i);

async function fillAccounts(entity: "welld_ch" | "welld_it", count: number): Promise<void> {
  await db.ledgerAccount.createMany({
    data: Array.from({ length: count }, (_, i) => ({ entity, number: numberOf(i), name: `Conto ${i}`, ...SEED_ACTOR })),
  });
}

async function fillVatCodes(entity: "welld_ch" | "welld_it", count: number): Promise<void> {
  await db.vatCode.createMany({
    data: Array.from({ length: count }, (_, i) => ({ entity, code: `C${i}`, label: `Aliquota ${i}`, rateBasisPoints: 100, ...SEED_ACTOR })),
  });
}

beforeAll(truncateAccountingTables);
beforeEach(async () => {
  await truncateAccountingTables();
  __resetAuthzCacheForTests();
});
afterAll(truncateAccountingTables);

describe("ledger accounts", () => {
  it("the last account that fits is created, the next one is 409 `catalog_full` with the limit, and nothing is written", async () => {
    await fillAccounts("welld_ch", CATALOG_CAPS.ledgerAccountsPerEntity - 1);

    const last = await call("POST", ACCOUNTS, { number: "5905", name: "Treno" });
    expect(last.status).toBe(201);
    expect(await db.ledgerAccount.count({ where: { entity: "welld_ch" } })).toBe(CATALOG_CAPS.ledgerAccountsPerEntity);

    const over = await call("POST", ACCOUNTS, { number: "5906", name: "Aereo" });
    expect(over.status).toBe(409);
    expect(over.body["code"]).toBe("catalog_full");
    expect(over.body["limit"]).toBe(CATALOG_CAPS.ledgerAccountsPerEntity);
    expect(over.body["detail"]).toContain(String(CATALOG_CAPS.ledgerAccountsPerEntity));
    expect(await db.ledgerAccount.count({ where: { entity: "welld_ch" } })).toBe(CATALOG_CAPS.ledgerAccountsPerEntity);
    expect(await db.ledgerAccount.findFirst({ where: { number: "5906" } })).toBeNull();
  });

  it("deactivated entries count (they are still served, and never deleted)", async () => {
    await fillAccounts("welld_ch", CATALOG_CAPS.ledgerAccountsPerEntity);
    const rows = await db.ledgerAccount.findMany({ select: { id: true } });
    await db.catalogStatusChange.createMany({
      data: rows.map((r) => ({ entity: "welld_ch" as const, ledgerAccountId: r.id, active: false, ...SEED_ACTOR })),
    });
    const res = await call("POST", ACCOUNTS, { number: "5906", name: "Aereo" });
    expect([res.status, res.body["code"]]).toEqual([409, "catalog_full"]);
  });

  it("at the cap an existing number is still told as a duplicate, with its `reactivate` flag (the way forward stays open)", async () => {
    await fillAccounts("welld_ch", CATALOG_CAPS.ledgerAccountsPerEntity);
    const res = await call("POST", ACCOUNTS, { number: numberOf(3), name: "Again" });
    expect([res.status, res.body["code"], res.body["reactivate"]]).toEqual([409, "ledger_account_duplicate", false]);
  });

  it("at the cap a refused value is still a 422, and deactivate and reactivate still work", async () => {
    await fillAccounts("welld_ch", CATALOG_CAPS.ledgerAccountsPerEntity);
    expect((await call("POST", ACCOUNTS, { number: "59a", name: "x" })).status).toBe(422);
    expect((await call("POST", `${ACCOUNTS}/${numberOf(0)}/deactivate`)).status).toBe(200);
    expect((await call("POST", `${ACCOUNTS}/${numberOf(0)}/reactivate`)).status).toBe(200);
  });

  it("the cap is per entity: a full WellD CH leaves WellD Italia free, and the other way round", async () => {
    await fillAccounts("welld_ch", CATALOG_CAPS.ledgerAccountsPerEntity);
    const italy = await call("POST", "/v1/entities/welld_it/ledger-accounts", { number: "5905", name: "Treno" }, PERSONAS.admin);
    expect(italy.status).toBe(201);
    expect((await call("POST", ACCOUNTS, { number: "5905", name: "Treno" })).body["code"]).toBe("catalog_full");
  });

  it("accounts and VAT codes are counted apart", async () => {
    await fillAccounts("welld_ch", CATALOG_CAPS.ledgerAccountsPerEntity);
    const vat = await call("POST", VATS, { code: "IMP81", label: "8.1", ratePercent: "8.1" });
    expect(vat.status).toBe(201);
  });

  it("concurrent creations at the cap minus one: exactly one is created, the others are `catalog_full`", async () => {
    await fillAccounts("welld_ch", CATALOG_CAPS.ledgerAccountsPerEntity - 1);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => call("POST", ACCOUNTS, { number: `7${i}`, name: `Racer ${i}` })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.body["code"] === "catalog_full")).toHaveLength(7);
    expect(await db.ledgerAccount.count({ where: { entity: "welld_ch" } })).toBe(CATALOG_CAPS.ledgerAccountsPerEntity);
  });
});

describe("VAT codes", () => {
  it("the last code that fits is created, the next one is 409 `catalog_full` with the limit, and nothing is written", async () => {
    await fillVatCodes("welld_ch", CATALOG_CAPS.vatCodesPerEntity - 1);

    expect((await call("POST", VATS, { code: "IMP81", label: "8.1", ratePercent: "8.1" })).status).toBe(201);
    const over = await call("POST", VATS, { code: "IMP77", label: "7.7", ratePercent: "7.7" });
    expect(over.status).toBe(409);
    expect(over.body["code"]).toBe("catalog_full");
    expect(over.body["limit"]).toBe(CATALOG_CAPS.vatCodesPerEntity);
    expect(await db.vatCode.count({ where: { entity: "welld_ch" } })).toBe(CATALOG_CAPS.vatCodesPerEntity);
    expect(await db.vatCode.findFirst({ where: { code: "IMP77" } })).toBeNull();
  });

  it("deactivated codes count; an existing code (any case) is still a duplicate at the cap", async () => {
    await fillVatCodes("welld_ch", CATALOG_CAPS.vatCodesPerEntity);
    const rows = await db.vatCode.findMany({ select: { id: true } });
    await db.catalogStatusChange.createMany({
      data: rows.map((r) => ({ entity: "welld_ch" as const, vatCodeId: r.id, active: false, ...SEED_ACTOR })),
    });
    expect((await call("POST", VATS, { code: "IMP77", label: "7.7", ratePercent: "7.7" })).body["code"]).toBe("catalog_full");
    const dup = await call("POST", VATS, { code: "c3", label: "again", ratePercent: "1" });
    expect([dup.status, dup.body["code"], dup.body["reactivate"]]).toEqual([409, "vat_code_duplicate", true]);
  });

  it("the cap is per entity", async () => {
    await fillVatCodes("welld_ch", CATALOG_CAPS.vatCodesPerEntity);
    const italy = await call("POST", "/v1/entities/welld_it/vat-codes", { code: "IMP81", label: "8.1", ratePercent: "8.1" }, PERSONAS.admin);
    expect(italy.status).toBe(201);
  });

  it("concurrent creations at the cap minus one: exactly one is created", async () => {
    await fillVatCodes("welld_ch", CATALOG_CAPS.vatCodesPerEntity - 1);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => call("POST", VATS, { code: `R${i}`, label: `Racer ${i}`, ratePercent: "1" })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.body["code"] === "catalog_full")).toHaveLength(7);
    expect(await db.vatCode.count({ where: { entity: "welld_ch" } })).toBe(CATALOG_CAPS.vatCodesPerEntity);
  });
});
