/**
 * Cross-service contract test (T46 QE pass, specs/20261119-accounting; plan R5 "contract drift", D23, D28).
 *
 * Both sides of the Accounting <-> Refund wire are otherwise tested against FAKES of the other side: refund-api's
 * `accountingClient` against `fakeAccounting`, accounting-api's system routes against hand-built requests. The shared
 * `accountingWire` file keeps the two SCHEMAS byte-identical (`shared:check`), but nothing runs the REAL client against
 * the REAL routes: the URL it builds, the `pairs` query it writes, the Bearer it sends, the chunking above 36 pairs, the
 * `attempted` flag, the one 401 re-mint. This file does that, in process (no listener, no network): refund-api's real
 * `createAccountingClient` is given a `fetchImpl` that calls accounting-api's real Hono app (real `systemAuth` verifying a
 * real RS256 service JWT, the real `accounting` database, a fake rates source).
 *
 * refund-api's client is IMPORTED here (`budgets.cross-package.test.ts` reads it as text because importing it evaluates
 * refund-api's `env`). The import is made possible by setting refund-api's required variables to placeholders for the
 * duration of this file and restoring `process.env` afterwards, because `bun test` runs every file in one process.
 *
 * AC coverage (as the wire sees it): 3.8, 2.10, 1.4/1.8/1.9/1.10 (the `active` state), 4.1 (what Refund lists), 6.8 (one
 * 401 re-mint, then unauthorized; a service that is not the allow-listed one is unavailable), 2.2 (attempted).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { fakeSource } from "../test-support/fakeSource";
import { truncateAccountingTables } from "../test-support/dbCleanup";
import { setupTestAuth, TEST_ISSUER, TEST_SERVICE_AUDIENCE } from "../test-support/testAuth";

const harness = setupTestAuth();
await harness.init();

// refund-api's env, as placeholders, only while its modules are first evaluated.
const REFUND_PLACEHOLDERS: Record<string, string> = {
  AUTH_BASE_URL: "http://localhost:3001",
  REFUND_S3_ENDPOINT: "http://localhost:9000",
  REFUND_S3_REGION: "eu-central-1",
  REFUND_S3_BUCKET: "contract-test",
  REFUND_S3_ACCESS_KEY_ID: "test",
  REFUND_S3_SECRET_ACCESS_KEY: "test",
  REFUND_S3_EU_ENDPOINT_HOSTS: "localhost",
  NOTIFY_INTERNAL_URL: "http://localhost:8081",
  SERVICE_CLIENT_ID: "refund-api",
  SERVICE_CLIENT_SECRET: "contract-test-secret-at-least-32-characters-long",
  ACCOUNTING_INTERNAL_URL: "http://accounting.invalid:8089",
  REFUND_APP_BASE_URL: "http://localhost:5173",
};
const touched = new Map<string, string | undefined>();
for (const [key, value] of Object.entries(REFUND_PLACEHOLDERS)) {
  if (process.env[key] === undefined) {
    touched.set(key, undefined);
    process.env[key] = value;
  }
}
const refundClient = await import("../../../refund-api/src/accounting/accountingClient");
const refundSnapshot = await import("../../../refund-api/src/accounting/referenceSnapshot");
for (const [key, previous] of touched) {
  if (previous === undefined) delete process.env[key];
}

const { OpenAPIHono } = await import("@hono/zod-openapi");
const { __setDefaultJwksForTests } = await import("../auth/systemAuth.middleware");
const { db } = await import("../lib/db");
const { createLedgerAccount, createVatCode, setLedgerAccountActive, setVatCodeActive } = await import("../catalog/catalog.repo");
const { appendCorrection } = await import("../rates/rates.repo");
const { createRatesService } = await import("../rates/rates.service");
const { handleProblemError, problem, validationHook } = await import("../lib/problem");
const { referenceDataRouter } = await import("./referenceData.routes");
const { createSystemRatesRouter } = await import("./rates.routes");
const { REFERENCE_READ_SCOPE } = await import("./readers");

const BASE = "http://accounting.contract-test";
const KID = "svc-contract-test";
const NOW = new Date("2026-11-19T10:00:00.000Z"); // October 2026 is the newest published month
let signingKey: CryptoKey;
let previousJwks: ReturnType<typeof __setDefaultJwksForTests>;

const serviceJwt = (sub = "system:refund-api", scope: string | null = REFERENCE_READ_SCOPE): Promise<string> => {
  const claims: Record<string, unknown> = {};
  if (scope !== null) claims["scope"] = scope;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt()
    .setIssuer(TEST_ISSUER)
    .setAudience(TEST_SERVICE_AUDIENCE)
    .setSubject(sub)
    .setExpirationTime("5m")
    .sign(signingKey);
};

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  signingKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  previousJwks = __setDefaultJwksForTests(createLocalJWKSet({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }));
});
afterAll(async () => {
  __setDefaultJwksForTests(previousJwks);
  await truncateAccountingTables();
});

let source = fakeSource();
const calls: { path: string; authorization: string | null }[] = [];

function buildApp() {
  const app = new OpenAPIHono({ defaultHook: validationHook });
  app.route("/", referenceDataRouter);
  app.route("/", createSystemRatesRouter(createRatesService({ mode: "bazg", fetcher: source.fetcher, now: () => NOW })));
  app.onError((err, c) => handleProblemError(err, c.req.path) ?? problem({ status: 500, detail: "unexpected" }, c.req.path));
  app.notFound((c) => problem({ status: 404, detail: "no route" }, c.req.path));
  return app;
}
let app = buildApp();

/** refund-api's real fetch seam, answered by accounting-api's real app. */
const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  expect(url.startsWith(BASE)).toBe(true);
  const path = url.slice(BASE.length);
  calls.push({ path, authorization: new Headers(init?.headers).get("authorization") });
  return app.request(path, init);
}) as typeof fetch;

function client(tokens: { getToken(): Promise<string>; invalidate(token: string): void }) {
  return refundClient.createAccountingClient({ baseUrl: BASE, tokens, fetchImpl, deadlineMs: 5_000 });
}
const goodTokens = { getToken: () => serviceJwt(), invalidate: () => undefined };

const actor = { userId: "user-seed", email: "seed@welld.ch" };
async function seed() {
  for (const [number, name] of [["5901", "Spese viaggi in treno"], ["5905", "Spese rimborsi chilometrici (viaggi)"], ["2620.1", "Conto con punto"], ["6101", "Spese materiale ufficio"]] as const) {
    await createLedgerAccount("welld_ch", { number, name }, actor);
  }
  await createLedgerAccount("welld_it", { number: "9001", name: "Conto Italia" }, actor);
  for (const [code, label, rateBasisPoints] of [["IMP81", "IVA 8.1%", 810], ["NOVAT", "Senza IVA", 0], ["IMP77", "IVA 7.7%", 770]] as const) {
    await createVatCode("welld_ch", { code, label, rateBasisPoints }, actor);
  }
  await setLedgerAccountActive("welld_ch", "6101", false, actor);
  await setVatCodeActive("welld_ch", "IMP77", false, actor);
}

beforeEach(async () => {
  await truncateAccountingTables();
  source = fakeSource();
  app = buildApp();
  calls.length = 0;
});

describe("the real Refund client against the real Accounting system routes (R5)", () => {
  it("reads WellD CH's reference data with the Bearer, parses it, and keeps the entity apart (AC-3.8)", async () => {
    await seed();
    const operation = client(goodTokens).begin("options");
    const data = await operation.referenceData("welld_ch");
    expect(data.entity).toBe("welld_ch");
    expect(data.ledgerAccounts.map((a) => [a.number, a.active])).toEqual([["2620.1", true], ["5901", true], ["5905", true], ["6101", false]]);
    expect(data.vatCodes.map((v) => [v.code, v.rateBasisPoints, v.active]).sort()).toEqual([["IMP77", 770, false], ["IMP81", 810, true], ["NOVAT", 0, true]]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/system/v1/entities/welld_ch/reference-data");
    expect(calls[0]!.authorization).toMatch(/^Bearer ey/);

    const italy = await client(goodTokens).begin("options").referenceData("welld_it");
    expect(italy.entity).toBe("welld_it");
    expect(italy.ledgerAccounts.map((a) => a.number)).toEqual(["9001"]);
  });

  it("the snapshot Refund builds from the live answer offers the active entries only, and sees a deactivated one as such (AC-4.1, AC-1.4, AC-1.8)", async () => {
    await seed();
    const snapshot = refundSnapshot.referenceSnapshot(await client(goodTokens).begin("options").referenceData("welld_ch"));
    expect(snapshot.activeAccounts().map((a) => a.number)).toEqual(["2620.1", "5901", "5905"]);
    expect(snapshot.activeVatCodes().map((v) => v.code)).toEqual(["IMP81", "NOVAT"]);
    expect(snapshot.lookupAccount("6101").state).toBe("deactivated");
    expect(snapshot.lookupVat("IMP77").state).toBe("deactivated");
    expect(snapshot.lookupAccount("9001").state).toBe("not_found"); // another entity's number
    // reactivation is seen by the next operation (AC-4.8: nothing is cached)
    await setLedgerAccountActive("welld_ch", "6101", true, actor);
    const later = refundSnapshot.referenceSnapshot(await client(goodTokens).begin("options").referenceData("welld_ch"));
    expect(later.lookupAccount("6101").state).toBe("active");
  });

  it("reads rates in the asked order: a recorded one, a published month fetched for the consumer, a month not yet published (AC-2.10)", async () => {
    await appendCorrection("welld_ch", { currency: "EUR", month: "2026-02", rateMicros: 950000, actor });
    const answers = await client(goodTokens)
      .begin("approve")
      .rates([
        { currency: "USD", month: "2026-03" },
        { currency: "EUR", month: "2026-02" },
        { currency: "EUR", month: "2026-11" },
      ]);
    expect(answers).toEqual([
      { currency: "USD", month: "2026-03", status: "in_effect", rateMicros: 780800, origin: "fetched", attempted: true },
      { currency: "EUR", month: "2026-02", status: "in_effect", rateMicros: 950000, origin: "corrected", attempted: false },
      { currency: "EUR", month: "2026-11", status: "missing", reason: "not_published", attempted: false },
    ]);
    expect(source.urls).toHaveLength(1); // March was fetched once, for the whole month; November was never asked
    expect(calls[0]!.path).toBe("/system/v1/entities/welld_ch/rates?pairs=USD:2026-03,EUR:2026-02,EUR:2026-11");
  });

  it("more than 36 distinct pairs are asked in several calls and every pair is answered once (client chunking x server limit)", async () => {
    const pairs: { currency: "EUR" | "USD" | "GBP"; month: string }[] = [];
    for (const month of ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2025-12", "2025-11", "2025-10", "2025-09"]) {
      for (const currency of ["EUR", "USD", "GBP"] as const) pairs.push({ currency, month });
    }
    expect(pairs.length).toBe(42);
    const answers = await client(goodTokens).begin("export").rates(pairs);
    expect(answers.map((a) => `${a.currency}:${a.month}`)).toEqual(pairs.map((p) => `${p.currency}:${p.month}`));
    expect(calls.map((c) => c.path.split("?")[0])).toEqual(["/system/v1/entities/welld_ch/rates", "/system/v1/entities/welld_ch/rates"]);
    // at most six months are attempted per request (R4): not every published pair of the 14 months can be in effect
    const inEffect = answers.filter((a) => a.status === "in_effect");
    expect(inEffect.length).toBeGreaterThan(0);
    expect(answers.every((a) => a.status === "in_effect" || a.status === "missing")).toBe(true);
  });

  it("one 401 re-mints the token once and then succeeds; a second 401 is `unauthorized` (AC-6.8)", async () => {
    await seed();
    let minted = 0;
    const flaky = {
      getToken: async () => (minted++ === 0 ? serviceJwt("system:refund-api", null) : serviceJwt()), // the first has no scope
      invalidate: () => undefined,
    };
    const data = await client(flaky).begin("view").referenceData("welld_ch");
    expect(data.ledgerAccounts.length).toBe(4);
    expect(minted).toBe(2);

    const never = { getToken: () => serviceJwt("system:refund-api", null), invalidate: () => undefined };
    await expect(client(never).begin("view").referenceData("welld_ch")).rejects.toMatchObject({ _tag: "AccountingUnavailableError", kind: "unauthorized" });
  });

  it("a service that is not on the allow-list cannot read: Refund sees it as unavailable, never as an empty list (AC-3.8, AC-6.8)", async () => {
    await seed();
    const stranger = { getToken: () => serviceJwt("system:crm-api"), invalidate: () => undefined };
    await expect(client(stranger).begin("view").referenceData("welld_ch")).rejects.toMatchObject({ kind: "unauthorized" });
    await expect(client(stranger).begin("view").rates([{ currency: "EUR", month: "2026-03" }])).rejects.toMatchObject({ kind: "unauthorized" });
    expect(source.urls).toHaveLength(0);
  });

  it("WellD Italia has no convertible currency: a rates ask for it is refused whole (422) and Refund reads that as unavailable, with nothing fetched or recorded (AC-2.11, AC-4.9)", async () => {
    await expect(client(goodTokens).begin("view").rates([{ currency: "EUR", month: "2026-03" }], "welld_it")).rejects.toMatchObject({ kind: "http_status" });
    expect(source.urls).toHaveLength(0);
    expect(await db.exchangeRateEntry.count()).toBe(0);
    expect(await db.exchangeRateFetchAttempt.count()).toBe(0);
  });
});
