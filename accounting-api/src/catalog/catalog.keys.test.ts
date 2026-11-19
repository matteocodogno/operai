/**
 * A key that cannot exist is a 404, never a 500 (T46 QE pass, specs/20261119-accounting; defect D-1; AC-1.4, AC-1.9, AC-1.10,
 * AC-1.11, AC-1.12, AC-3.5 "refused as if the entry did not exist", plan § API "unknown number or code -> 404 not_found").
 *
 * The `{number}` and `{code}` of the deactivate and reactivate routes are bound into a raw `SELECT ... FOR UPDATE`. A NUL byte
 * (`%00`) in either is a value Postgres cannot store or compare (SQLSTATE 22021), and today it reaches the database and comes
 * back as an uncaught 500. A manager can send it (any holder of Accounting manage for the entity); nothing is written and the
 * body is the generic one, so the harm is small, but the documented answer for a key that is not there is 404 `not_found`, and
 * `limits.ts` already names this exact hazard for names and labels ("NUL would be a 500, not a refusal").
 *
 * The first two groups fail at the commit this was written on (3 red tests); the others pass and pin the neighbours so the fix
 * does not widen anything. The fix is the route's, not this file's: validate the path key with the same pattern as the body
 * (or map the database error), and answer 404.
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

async function post(path: string) {
  __resetAuthzCacheForTests();
  harness.setResolve(fakeResolve(PERSONAS.accountingCh));
  const token = await harness.signToken({ sub: PERSONAS.accountingCh.sub, email: `${PERSONAS.accountingCh.sub}@welld.ch` });
  const res = await app.request(path, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

const ACCOUNTS = "/v1/entities/welld_ch/ledger-accounts";
const VATS = "/v1/entities/welld_ch/vat-codes";

beforeAll(truncateAccountingTables);
beforeEach(async () => {
  await truncateAccountingTables();
  __resetAuthzCacheForTests();
});
afterAll(truncateAccountingTables);

describe("a NUL byte in the key of an entry is a 404 `not_found`, not a 500 (D-1)", () => {
  for (const action of ["deactivate", "reactivate"] as const) {
    it(`ledger account: ${action} 5905%00 answers 404 and writes nothing`, async () => {
      const res = await post(`${ACCOUNTS}/5905%00/${action}`);
      expect(res.status).toBe(404);
      expect(res.body["code"]).toBe("not_found");
      expect(await db.catalogStatusChange.count()).toBe(0);
    });
  }

  it("VAT code: deactivate IMP%00 answers 404 and writes nothing", async () => {
    const res = await post(`${VATS}/IMP%00/deactivate`);
    expect(res.status).toBe(404);
    expect(res.body["code"]).toBe("not_found");
    expect(await db.catalogStatusChange.count()).toBe(0);
  });
});

describe("the neighbours of D-1 already answer 404 (pinned so the fix does not move them)", () => {
  it.each([
    ["a control character", "5905%0A"],
    ["a slash", "59%2F05"],
    ["a space", "59%2005"],
    ["a non-ASCII digit", "%EF%BC%95%EF%BC%99"],
    ["a very long key", "9".repeat(5000)],
    ["an empty-looking key", "."],
  ])("ledger account with %s in the key: deactivate is 404", async (_label, key) => {
    const res = await post(`${ACCOUNTS}/${key}/deactivate`);
    expect(res.status).toBe(404);
  });

  it.each([
    ["a control character", "IMP%0A"],
    ["a space", "IMP%2081"],
    ["a very long key", "A".repeat(5000)],
  ])("VAT code with %s in the key: deactivate is 404", async (_label, key) => {
    const res = await post(`${VATS}/${key}/deactivate`);
    expect(res.status).toBe(404);
  });
});
