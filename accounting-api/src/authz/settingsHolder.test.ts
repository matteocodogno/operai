/**
 * AC-3.7, the Accounting half (T46 QE pass, specs/20261119-accounting): a person who holds Refund's `settings:read` and
 * `settings:manage` (and every other Refund grant) and NO Accounting capability gets nothing from accounting-api.
 *
 * The plan's AC-3.7 row names this case ("the same user at accounting-api -> 403") for int-A, but the suite's `outsider` persona
 * has an EMPTY permission set, so a bug that let a `settings` or `refund` grant stand in for an Accounting one (a resource
 * match on the action alone, a prefix match, a catalog mix-up) would pass every other test. This persona carries the whole
 * Refund and settings catalog, with and without the entity condition, so such a bug fails here. The refund-api half (the
 * removed routes answer 404; an Accounting manager without `settings:manage` gets 403 on the defaults) is in
 * `refund-api/src/removed-routes.test.ts` and `accounting/defaults.routes.test.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { ENTITY_CONDITION, fakeResolve, type Persona } from "../test-support/fakeResolve";
import { truncateAccountingTables } from "../test-support/dbCleanup";
import { setupTestAuth } from "../test-support/testAuth";

const harness = setupTestAuth();
await harness.init();

const { app } = await import("../index");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("./authz.middleware");

const REFUND_ACTIONS: readonly [string, string][] = [
  ["refund", "access"],
  ["settings", "read"],
  ["settings", "manage"],
  ["request", "create"],
  ["request", "read"],
  ["request", "review"],
  ["request", "set-approved-total"],
  ["request", "approve"],
  ["request", "reject"],
  ["request", "reclassify"],
];

/** Every Refund grant, once unconditioned and once entity-conditioned, and not one `accounting` grant. */
const settingsHolder: Persona = {
  sub: "user-settings-holder",
  entity: "welld_ch",
  permissions: REFUND_ACTIONS.flatMap(([resource, action]) => [
    { resource, action, conditions: null },
    { resource, action, conditions: ENTITY_CONDITION },
  ]),
};

async function call(method: string, path: string, body?: unknown) {
  __resetAuthzCacheForTests();
  harness.setResolve(fakeResolve(settingsHolder));
  const token = await harness.signToken({ sub: settingsHolder.sub, email: `${settingsHolder.sub}@welld.ch` });
  const res = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, text, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

beforeAll(truncateAccountingTables);
beforeEach(async () => {
  await truncateAccountingTables();
  __resetAuthzCacheForTests();
});
afterAll(truncateAccountingTables);

describe("a Refund settings holder with no Accounting capability is denied everywhere in accounting-api (AC-3.7, AC-3.9)", () => {
  const E = "/v1/entities/welld_ch";
  // Every row has three elements: bun reads a callback with more parameters than the row has as one that takes `done`.
  const requests: readonly (readonly [string, string, unknown])[] = [
    ["GET", "/v1/me", undefined],
    ["GET", `${E}/ledger-accounts`, undefined],
    ["GET", `${E}/vat-codes`, undefined],
    ["GET", `${E}/exchange-rates`, undefined],
    ["POST", `${E}/ledger-accounts`, { number: "5905", name: "Spese" }],
    ["POST", `${E}/vat-codes`, { code: "IMP81", label: "IVA 8.1%", ratePercent: "8.1" }],
    ["POST", `${E}/ledger-accounts/5905/deactivate`, undefined],
    ["POST", `${E}/vat-codes/IMP81/reactivate`, undefined],
    ["PUT", `${E}/exchange-rates/2026-03/EUR`, { rate: "0.9246" }],
    ["POST", `${E}/exchange-rates/fetch`, {}],
    ["GET", "/v1/entities/welld_it/ledger-accounts", undefined],
  ];

  it.each(requests)("%s %s answers 403 accounting_forbidden, with nothing of the lists", async (method, path, body) => {
    const res = await call(method, path, body);
    expect(res.status).toBe(403);
    expect(res.body["code"]).toBe("accounting_forbidden");
    expect(res.text).not.toMatch(/Spese|IVA|ledgerAccounts|"items"|rateMicros/);
  });

  it("wrote nothing", async () => {
    for (const [method, path, body] of requests) await call(method, path, body);
    expect(await db.ledgerAccount.count()).toBe(0);
    expect(await db.vatCode.count()).toBe(0);
    expect(await db.catalogStatusChange.count()).toBe(0);
    expect(await db.exchangeRateEntry.count()).toBe(0);
    expect(await db.exchangeRateFetchAttempt.count()).toBe(0);
  });
});
