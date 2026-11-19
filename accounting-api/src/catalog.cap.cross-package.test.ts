/**
 * The largest catalog accounting-api allows is an answer refund-api can read (security-review F-01, specs/20261119-accounting;
 * AC-6.1, AC-6.8, plan R5; the same idea as `budgets.cross-package.test.ts`).
 *
 * Refund reads an entity's WHOLE reference data in one body and refuses anything over its `ACCOUNTING_MAX_BODY_BYTES` as
 * `too_large`, which makes every approve, classify, options read, defaults write, export with a pending rate and the release
 * answer 503 `accounting_unavailable`. Entries are never deleted and deactivated ones are still served, so only a cap on the number of
 * entries keeps the answer readable. This builds the LARGEST catalog the caps and the field limits allow (every entry at its
 * longest, in the characters that take most bytes, all deactivated), reads it through the real `/system/v1` route with a real service
 * JWT, and asserts that the body is at most HALF of the consumer's cap. Raising a cap or a field limit without looking at Refund
 * fails here first.
 *
 * HOW THE REFUND CONSTANT IS READ: as text, never imported (see `budgets.cross-package.test.ts`: refund-api's module evaluates its
 * own env and has its own `node_modules`). A missing file, a declaration that is absent, repeated or not a plain number is a
 * FAILURE, never a skip.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { TEST_ISSUER, TEST_SERVICE_AUDIENCE } from "./test-support/testAuth"; // first: it sets the environment the modules below read
import { truncateAccountingTables } from "./test-support/dbCleanup";

const { app } = await import("./index");
const { __setDefaultJwksForTests } = await import("./auth/systemAuth.middleware");
const { db } = await import("./lib/db");
const { CATALOG_CAPS, checkLedgerName, checkLedgerNumber, checkVatCode, checkVatLabel, LIMITS } = await import("./catalog/limits");
const { REFERENCE_READ_SCOPE } = await import("./system/readers");

const CLIENT_URL = new URL("../../refund-api/src/accounting/accountingClient.ts", import.meta.url);

/** The value of the one `export const ACCOUNTING_MAX_BODY_BYTES = <n | n * n>;` of `source`; throws when it is not exactly that. */
function maxBodyBytesOf(source: string): number {
  const declarations = [...source.matchAll(/^export const ACCOUNTING_MAX_BODY_BYTES\s*(?::\s*number\s*)?=\s*([^;\n]*);/gm)];
  if (declarations.length !== 1) throw new Error(`expected exactly one \`export const ACCOUNTING_MAX_BODY_BYTES = …;\`, found ${declarations.length}`);
  const expression = declarations[0]![1]!.trim();
  if (!/^\d[\d_]*(\s*\*\s*\d[\d_]*)*$/.test(expression)) throw new Error(`ACCOUNTING_MAX_BODY_BYTES is not a plain number or product of numbers: ${expression}`);
  return expression.split("*").reduce((product, factor) => product * Number(factor.trim().replaceAll("_", "")), 1);
}

function readMaxBodyBytes(): number {
  if (!existsSync(CLIENT_URL)) throw new Error(`refund-api's accounting client is not at ${CLIENT_URL.pathname}: this test does not skip, the size it checks has to be checkable`);
  return maxBodyBytesOf(readFileSync(CLIENT_URL, "utf8"));
}

describe("the reader of the refund-api constant", () => {
  it("evaluates a number, a number with separators and a product, and refuses anything else", () => {
    expect(maxBodyBytesOf("export const ACCOUNTING_MAX_BODY_BYTES = 262_144;")).toBe(262_144);
    expect(maxBodyBytesOf("export const ACCOUNTING_MAX_BODY_BYTES: number = 256 * 1024;")).toBe(262_144);
    for (const bad of [
      "",
      "const ACCOUNTING_MAX_BODY_BYTES = 262_144;",
      "export const ACCOUNTING_MAX_BODY_BYTES = env.MAX;",
      "export const ACCOUNTING_MAX_BODY_BYTES = 256 + 1;",
      "export const ACCOUNTING_MAX_BODY_BYTES = 1;\nexport const ACCOUNTING_MAX_BODY_BYTES = 2;",
    ]) {
      expect(() => maxBodyBytesOf(bad)).toThrow();
    }
  });

  it("reads refund-api's limit: 256 KiB", () => {
    expect(readMaxBodyBytes()).toBe(256 * 1024);
  });
});

describe("the largest allowed reference-data answer stays at most half of refund-api's body limit", () => {
  const KID = "svc-cap-test";
  let token: string;
  let previousJwks: ReturnType<typeof __setDefaultJwksForTests>;

  /** The characters that take most bytes in UTF-8 (4) and in JSON (a quote takes 2, an astral character 4: the astral one wins). */
  const WIDE = "\u{1F600}";

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    const jwk = await exportJWK(pair.publicKey);
    previousJwks = __setDefaultJwksForTests(createLocalJWKSet({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }));
    token = await new SignJWT({ scope: REFERENCE_READ_SCOPE })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt()
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_SERVICE_AUDIENCE)
      .setSubject("system:refund-api")
      .setExpirationTime("5m")
      .sign(pair.privateKey);
    await truncateAccountingTables();
  });

  afterAll(async () => {
    __setDefaultJwksForTests(previousJwks);
    await truncateAccountingTables();
  });

  it("every entry at its longest, all deactivated, up to the caps", async () => {
    const accountName = WIDE.repeat(LIMITS.ledgerNameMax);
    const vatLabel = WIDE.repeat(LIMITS.vatLabelMax);
    // The fixture is only the largest ALLOWED one if the checks of the routes accept it.
    expect(checkLedgerName(accountName)).toEqual({ ok: true, value: accountName });
    expect(checkVatLabel(vatLabel)).toEqual({ ok: true, value: vatLabel });
    const numberOf = (i: number) => String(i).padStart(LIMITS.ledgerNumberMax, "0");
    const codeOf = (i: number) => `V${String(i).padStart(LIMITS.vatCodeMax - 1, "0")}`;
    expect(checkLedgerNumber(numberOf(CATALOG_CAPS.ledgerAccountsPerEntity - 1)).ok).toBe(true);
    expect(checkVatCode(codeOf(CATALOG_CAPS.vatCodesPerEntity - 1)).ok).toBe(true);

    const actor = { createdByUserId: "user-seed", createdByEmail: "seed@welld.ch" };
    await db.ledgerAccount.createMany({
      data: Array.from({ length: CATALOG_CAPS.ledgerAccountsPerEntity }, (_, i) => ({ entity: "welld_ch" as const, number: numberOf(i), name: accountName, ...actor })),
    });
    await db.vatCode.createMany({
      data: Array.from({ length: CATALOG_CAPS.vatCodesPerEntity }, (_, i) => ({ entity: "welld_ch" as const, code: codeOf(i), label: vatLabel, rateBasisPoints: 10_000, ...actor })),
    });
    await db.catalogStatusChange.createMany({
      data: [
        ...(await db.ledgerAccount.findMany({ select: { id: true } })).map((r) => ({ entity: "welld_ch" as const, ledgerAccountId: r.id, active: false, ...actor })),
        ...(await db.vatCode.findMany({ select: { id: true } })).map((r) => ({ entity: "welld_ch" as const, vatCodeId: r.id, active: false, ...actor })),
      ],
    });

    const res = await app.request("/system/v1/entities/welld_ch/reference-data", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const raw = new Uint8Array(await res.arrayBuffer());
    const bytes = raw.byteLength;
    const body = JSON.parse(new TextDecoder().decode(raw)) as { ledgerAccounts: unknown[]; vatCodes: unknown[] };
    // Nothing of the fixture was left out of the answer measured.
    expect(body.ledgerAccounts).toHaveLength(CATALOG_CAPS.ledgerAccountsPerEntity);
    expect(body.vatCodes).toHaveLength(CATALOG_CAPS.vatCodesPerEntity);

    const limit = readMaxBodyBytes();
    console.log(`[cap] largest allowed reference-data answer: ${bytes} bytes of ${limit} (${((bytes / limit) * 100).toFixed(1)} %)`);
    expect(bytes).toBeLessThanOrEqual(limit / 2);
  });
});
